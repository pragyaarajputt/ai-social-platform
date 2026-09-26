import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import type { WorkspaceRole } from "../src/generated/prisma/enums.js";
import { testOutbox } from "../src/services/email.service.js";
import { runPreflightChecks } from "../src/services/preflight.service.js";
import { auth, connectPage, createPost, installFakes, signUp, type User } from "./support.js";

beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces, audit_logs CASCADE");
  installFakes();
  testOutbox.length = 0;
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

const PASSWORD = "correct horse battery";
const ws = (u: User, path = "") => `/api/v1/workspaces/${u.workspaceId}${path}`;
const emailOf = async (u: User) => (await prisma.user.findUniqueOrThrow({ where: { id: u.userId } })).email;
const verify = (u: User) => prisma.user.update({ where: { id: u.userId }, data: { emailVerifiedAt: new Date() } });
const tokenFrom = (link: string) => link.split("/invite/")[1]!;
/** Adds `member` to `owner`'s workspace with a role, directly. */
const addMember = (owner: User, member: User, role: WorkspaceRole) =>
  prisma.workspaceMember.create({ data: { workspaceId: owner.workspaceId, userId: member.userId, role } });
/** `member`'s view of `owner`'s workspace. */
const as = (member: User, owner: User): User => ({ ...member, workspaceId: owner.workspaceId });

async function invite(owner: User, email: string, role: WorkspaceRole = "EDITOR") {
  const res = await request(app).post(ws(owner, "/invites")).set(auth(owner)).send({ email, role });
  expect(res.status).toBe(201);
  return { ...res.body, token: tokenFrom(res.body.link) as string };
}
const accept = (u: User, token: string) => request(app).post(`/api/v1/invites/${token}/accept`).set(auth(u));

// ─── Inviting ───────────────────────────────────────────────────────────────

describe("invites", () => {
  it("emails a link; the invited person previews it signed out, then accepts it and joins with that role", async () => {
    const owner = await signUp();
    const bob = await signUp();
    await verify(bob);
    const { invite: created, link, token } = await invite(owner, await emailOf(bob), "EDITOR");
    expect(created).toMatchObject({ role: "EDITOR", state: "pending" });
    expect(link).toMatch(/^http:\/\/localhost:3000\/invite\/[\w-]{43}$/);
    expect(testOutbox.at(-1)).toMatchObject({ to: await emailOf(bob), subject: "Publisher invited you to Publisher's workspace" });
    expect(testOutbox.at(-1)!.text).toContain(link);
    // Only the hash is stored.
    expect(JSON.stringify(await prisma.workspaceInvite.findFirstOrThrow())).not.toContain(token);

    const preview = await request(app).get(`/api/v1/invites/${token}`);
    expect(preview.body.invite).toMatchObject({ workspaceName: "Publisher's workspace", inviterName: "Publisher", role: "EDITOR", state: "pending" });
    expect(preview.body.invite.email).toMatch(/^p\*\*\*@example\.test$/);

    const res = await accept(bob, token);
    expect(res.body).toEqual({ workspaceId: owner.workspaceId });
    const list = await request(app).get("/api/v1/workspaces").set(auth(bob));
    expect(list.body.workspaces.map((w: { role: string; isPersonal: boolean }) => [w.role, w.isPersonal])).toEqual([
      ["OWNER", true],
      ["EDITOR", true],
    ]);
    // Accepting again just lands in the workspace; nobody else can use the link.
    expect((await accept(bob, token)).status).toBe(200);
    const carol = await signUp();
    await verify(carol);
    expect((await accept(carol, token)).body.error.code).toBe("INVITE_USED");
  });

  it("only works for the invited, verified email, while the invite is valid", async () => {
    const owner = await signUp();
    const bob = await signUp();
    const mallory = await signUp();
    await verify(mallory);
    const { token } = await invite(owner, await emailOf(bob));

    const wrong = await accept(mallory, token);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toMatchObject({ code: "INVITE_EMAIL_MISMATCH" });
    expect(wrong.body.error.message).toContain("p***@example.test");
    expect((await accept(bob, token)).body.error.code).toBe("EMAIL_NOT_VERIFIED");
    expect((await request(app).post(`/api/v1/invites/${token}/accept`)).status).toBe(401);
    expect((await request(app).get("/api/v1/invites/not-a-real-token-at-all-000")).status).toBe(404);

    await verify(bob);
    await prisma.workspaceInvite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).get(`/api/v1/invites/${token}`)).body.invite.state).toBe("expired");
    expect((await accept(bob, token)).body.error.code).toBe("INVITE_EXPIRED");
    expect(await prisma.workspaceMember.count({ where: { workspaceId: owner.workspaceId } })).toBe(1);
  });

  it("works for someone who signs up after being invited", async () => {
    const owner = await signUp();
    const { token } = await invite(owner, "newcomer@example.test", "VIEWER");
    const reg = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: "NewComer@example.test", username: "newcomer", password: PASSWORD, displayName: "New Comer" });
    const newcomer: User = { token: reg.body.accessToken, userId: reg.body.user.id, workspaceId: "" };
    await verify(newcomer);
    expect((await accept(newcomer, token)).body.workspaceId).toBe(owner.workspaceId);
    expect(await prisma.workspaceMember.findFirst({ where: { workspaceId: owner.workspaceId, userId: newcomer.userId } })).toMatchObject({ role: "VIEWER" });
  });

  it("resends instead of duplicating, can be revoked, and refuses members and floods", async () => {
    const owner = await signUp();
    const bob = await signUp();
    const first = await invite(owner, await emailOf(bob));
    const tooSoon = await request(app).post(ws(owner, "/invites")).set(auth(owner)).send({ email: await emailOf(bob), role: "VIEWER" });
    expect(tooSoon.body.error.code).toBe("RESEND_TOO_SOON");

    await prisma.workspaceInvite.updateMany({ data: { lastSentAt: new Date(Date.now() - 120_000) } });
    const resent = await request(app).post(ws(owner, `/invites/${first.invite.id}/resend`)).set(auth(owner));
    expect(resent.status).toBe(200);
    expect(await prisma.workspaceInvite.count()).toBe(1);
    // The old link stopped working when a new one was sent.
    expect((await request(app).get(`/api/v1/invites/${first.token}`)).status).toBe(404);
    const newToken = tokenFrom(resent.body.link);

    expect((await request(app).get(ws(owner, "/invites")).set(auth(owner))).body.invites).toHaveLength(1);
    expect((await request(app).delete(ws(owner, `/invites/${first.invite.id}`)).set(auth(owner))).status).toBe(204);
    expect((await request(app).get(`/api/v1/invites/${newToken}`)).body.invite.state).toBe("revoked");
    expect((await request(app).get(ws(owner, "/invites")).set(auth(owner))).body.invites).toHaveLength(0);

    const member = await signUp();
    await addMember(owner, member, "VIEWER");
    const again = await request(app).post(ws(owner, "/invites")).set(auth(owner)).send({ email: await emailOf(member), role: "EDITOR" });
    expect(again.body.error.code).toBe("ALREADY_MEMBER");

    await prisma.auditLog.createMany({ data: Array.from({ length: 20 }, () => ({ workspaceId: owner.workspaceId, action: "workspace.invite_sent" })) });
    const flood = await request(app).post(ws(owner, "/invites")).set(auth(owner)).send({ email: "someone@example.test", role: "EDITOR" });
    expect(flood.status).toBe(429);
    const owner2 = await signUp();
    expect((await request(app).post(ws(owner2, "/invites")).set(auth(owner2)).send({ email: "x@example.test", role: "OWNER" })).status).toBe(400);
  });
});

// ─── Permissions ────────────────────────────────────────────────────────────

describe("roles", () => {
  async function team() {
    const owner = await signUp();
    const [admin, admin2, editor, viewer] = [await signUp(), await signUp(), await signUp(), await signUp()];
    await addMember(owner, admin, "ADMIN");
    await addMember(owner, admin2, "ADMIN");
    await addMember(owner, editor, "EDITOR");
    await addMember(owner, viewer, "VIEWER");
    return { owner, admin: as(admin, owner), admin2: as(admin2, owner), editor: as(editor, owner), viewer: as(viewer, owner) };
  }
  const setRole = (actor: User, target: User, role: string) => request(app).patch(ws(actor, `/members/${target.userId}`)).set(auth(actor)).send({ role });
  const remove = (actor: User, target: User) => request(app).delete(ws(actor, `/members/${target.userId}`)).set(auth(actor)).send({});
  const roleOf = async (u: User) => (await prisma.workspaceMember.findFirstOrThrow({ where: { workspaceId: u.workspaceId, userId: u.userId } })).role;

  it("lets everyone see the team, but only managers see email addresses", async () => {
    const t = await team();
    const asViewer = await request(app).get(ws(t.viewer, "/members")).set(auth(t.viewer));
    expect(asViewer.body.members).toHaveLength(5);
    expect(asViewer.body.members.filter((m: { email: string | null }) => m.email)).toHaveLength(1); // only their own
    const asAdmin = await request(app).get(ws(t.admin, "/members")).set(auth(t.admin));
    expect(asAdmin.body.members.every((m: { email: string | null }) => m.email)).toBe(true);
  });

  it("follows the permission table", async () => {
    const t = await team();
    // Viewers and editors can't invite; admins can, including other admins.
    for (const who of [t.viewer, t.editor]) {
      expect((await request(app).post(ws(who, "/invites")).set(auth(who)).send({ email: "a@example.test", role: "VIEWER" })).status).toBe(403);
    }
    expect((await request(app).post(ws(t.admin, "/invites")).set(auth(t.admin)).send({ email: "a@example.test", role: "ADMIN" })).status).toBe(201);
    // Viewers can't post; editors can.
    const page = await connectPage(t.owner);
    const post = { caption: "Hello", targets: [{ socialAccountId: page.id }], scheduledAt: new Date(Date.now() + 3_600_000).toISOString() };
    expect((await createPost(t.viewer, post)).status).toBe(403);
    expect((await createPost(t.editor, post)).status).toBe(201);

    // Admins manage editors and viewers, and may promote to admin...
    expect((await setRole(t.admin, t.editor, "VIEWER")).status).toBe(204);
    expect((await setRole(t.admin, t.viewer, "ADMIN")).status).toBe(204);
    expect(await roleOf(t.viewer)).toBe("ADMIN");
    // ...but not other admins, the owner, or themselves.
    expect((await setRole(t.admin, t.admin2, "EDITOR")).status).toBe(403);
    expect((await remove(t.admin, t.admin2)).status).toBe(403);
    expect((await setRole(t.admin, t.owner, "EDITOR")).status).toBe(403);
    expect((await setRole(t.admin, t.admin, "EDITOR")).status).toBe(403);
    expect((await setRole(t.editor, t.viewer, "VIEWER")).status).toBe(403);
    // The owner can; nobody can hand out OWNER through a role change.
    expect((await setRole(t.owner, t.admin2, "EDITOR")).status).toBe(204);
    expect((await setRole(t.owner, t.admin, "OWNER")).status).toBe(400);
    expect((await remove(t.owner, t.admin2)).status).toBe(200);
    expect(await prisma.workspaceMember.count({ where: { workspaceId: t.owner.workspaceId, role: "OWNER" } })).toBe(1);
  });

  it("transfers ownership with the name and password, keeping exactly one owner", async () => {
    const t = await team();
    const transfer = (body: object) => request(app).post(ws(t.owner, "/transfer-ownership")).set(auth(t.owner)).send(body);
    const name = "Publisher's workspace";
    expect((await transfer({ userId: t.admin.userId, confirmName: name, password: "wrong password" })).body.error.code).toBe("WRONG_PASSWORD");
    expect((await transfer({ userId: t.admin.userId, confirmName: "nope", password: PASSWORD })).body.error.code).toBe("CONFIRMATION_MISMATCH");
    expect((await request(app).post(ws(t.admin, "/transfer-ownership")).set(auth(t.admin)).send({ userId: t.admin.userId, confirmName: name, password: PASSWORD })).status).toBe(403);

    // Two transfers at once: only one can win.
    const results = await Promise.all([
      transfer({ userId: t.admin.userId, confirmName: name, password: PASSWORD }),
      transfer({ userId: t.editor.userId, confirmName: name, password: PASSWORD }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 403]);
    expect(await prisma.workspaceMember.count({ where: { workspaceId: t.owner.workspaceId, role: "OWNER" } })).toBe(1);
    expect(await roleOf(t.owner)).toBe("ADMIN");
  });

  it("lets members leave, but not the owner, and access ends immediately", async () => {
    const t = await team();
    expect((await request(app).post(ws(t.owner, "/members/me/leave")).set(auth(t.owner))).body.error.code).toBe("OWNER_CANT_LEAVE");
    expect((await request(app).post(ws(t.editor, "/members/me/leave")).set(auth(t.editor))).status).toBe(204);
    expect((await request(app).get(ws(t.editor, "/posts")).set(auth(t.editor))).status).toBe(404);
    // Removed members too.
    expect((await remove(t.admin, t.viewer)).status).toBe(200);
    expect((await request(app).get(ws(t.viewer, "/posts")).set(auth(t.viewer))).status).toBe(404);
  });

  it("can't manage another workspace's team", async () => {
    const a = await signUp();
    const b = await signUp();
    const bMember = await signUp();
    await addMember(b, bMember, "EDITOR");
    expect((await request(app).patch(`/api/v1/workspaces/${b.workspaceId}/members/${bMember.userId}`).set(auth(a)).send({ role: "VIEWER" })).status).toBe(404);
    expect((await request(app).get(`/api/v1/workspaces/${b.workspaceId}/invites`).set(auth(a))).status).toBe(404);
  });
});

// ─── Removing members: their accounts and posts ─────────────────────────────

describe("removing a member", () => {
  async function setup() {
    const owner = await signUp();
    const editor = await signUp();
    await addMember(owner, editor, "EDITOR");
    const page = await connectPage(owner);
    await prisma.socialAccount.update({ where: { id: page.id }, data: { connectedById: editor.userId } });
    const post = await createPost(as(editor, owner), { caption: "By the editor", targets: [{ socialAccountId: page.id }], scheduledAt: new Date(Date.now() + 5 * 3_600_000).toISOString() });
    return { owner, editor, page, postId: post.body.post.id as string };
  }

  it("disconnects the accounts they connected by default", async () => {
    const { owner, editor, page, postId } = await setup();
    const res = await request(app).delete(ws(owner, `/members/${editor.userId}`)).set(auth(owner)).send({});
    expect(res.body).toEqual({ disconnectedAccounts: 1 });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: page.id } })).status).toBe("DISCONNECTED");
    // Their post stays in the workspace (its only account was disconnected, so it's cancelled).
    expect((await prisma.post.findUniqueOrThrow({ where: { id: postId } })).status).toBe("CANCELLED");
  });

  it("can keep them, shows who connected them, and sends warnings to managers instead of the removed author", async () => {
    const { owner, editor, page } = await setup();
    await request(app).delete(ws(owner, `/members/${editor.userId}`)).set(auth(owner)).send({ disconnectAccounts: false });
    const accounts = await request(app).get(ws(owner, "/social-accounts")).set(auth(owner));
    expect(accounts.body.accounts[0]).toMatchObject({ status: "ACTIVE", connectedBy: { id: editor.userId, name: "Publisher", stillMember: false } });

    await prisma.socialAccount.update({ where: { id: page.id }, data: { status: "NEEDS_REAUTH" } });
    expect(await runPreflightChecks()).toEqual({ warnedPosts: 1, targets: 1 });
    const warnings = testOutbox.filter((e) => e.subject === "A scheduled post needs your attention");
    expect(warnings.map((e) => e.to)).toEqual([await emailOf(owner)]);
  });
});

// ─── Workspaces ─────────────────────────────────────────────────────────────

describe("workspaces", () => {
  it("creates, renames and deletes workspaces, but never your only one", async () => {
    const u = await signUp();
    const created = await request(app).post("/api/v1/workspaces").set(auth(u)).send({ name: "  Client: Pune Cafe " });
    expect(created.status).toBe(201);
    expect(created.body.workspace).toMatchObject({ name: "Client: Pune Cafe", role: "OWNER", isPersonal: false });
    const other: User = { ...u, workspaceId: created.body.workspace.id };

    expect((await request(app).patch(ws(other)).set(auth(u)).send({ name: "Pune Cafe" })).status).toBe(204);
    const del = (w: User, body: object) => request(app).delete(ws(w)).set(auth(u)).send(body);
    expect((await del(other, { confirmName: "Pune Cafe", password: "nope" })).body.error.code).toBe("WRONG_PASSWORD");
    expect((await del(other, { confirmName: "Pune Cafe", password: PASSWORD })).status).toBe(204);
    expect(await prisma.workspace.count({ where: { id: other.workspaceId } })).toBe(0);

    const only = await del(u, { confirmName: "Publisher's workspace", password: PASSWORD });
    expect(only.body.error.code).toBe("LAST_WORKSPACE");
  });

  it("waits while a post is being published, and only the owner can delete", async () => {
    const u = await signUp();
    const created = await request(app).post("/api/v1/workspaces").set(auth(u)).send({ name: "Busy" });
    const busy: User = { ...u, workspaceId: created.body.workspace.id };
    const page = await connectPage(busy);
    const post = await createPost(busy, { caption: "Now", targets: [{ socialAccountId: page.id }] });
    await prisma.postTarget.updateMany({ where: { postId: post.body.post.id }, data: { status: "PUBLISHING" } });
    expect((await request(app).delete(ws(busy)).set(auth(u)).send({ confirmName: "Busy", password: PASSWORD })).body.error.code).toBe("PUBLISHING_IN_PROGRESS");

    const admin = await signUp();
    await addMember(busy, admin, "ADMIN");
    expect((await request(app).delete(ws(as(admin, busy))).set(auth(admin)).send({ confirmName: "Busy", password: PASSWORD })).status).toBe(403);
  });
});
