import { createHash, randomBytes } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { facebookAdapter } from "../src/integrations/facebook/adapter.js";
import { runConnectionHealthChecks } from "../src/jobs/connectionHealth.js";
import { keyVersionCounts, reencryptOldTokens } from "../src/jobs/keyRotation.js";
import { runPublishCycle } from "../src/jobs/publishQueue.js";
import { testOutbox } from "../src/services/email.service.js";
import { runPreflightChecks } from "../src/services/preflight.service.js";
import { parseKeyRing } from "../src/utils/keyRing.js";
import { decryptToken, encryptToken } from "../src/utils/tokenCrypto.js";
import { addMedia, auth, connectAccount, connectPage, createPost, fake, fb, FB_PAGE, installFakes, signUp, type User } from "./support.js";

const originalKeys = env.tokenKeys;
beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces, audit_logs CASCADE");
  installFakes();
  testOutbox.length = 0;
});
afterEach(() => {
  env.tokenKeys = originalKeys;
  vi.restoreAllMocks();
});
afterAll(() => prisma.$disconnect());

const HOUR = 3_600_000;
const startFacebook = async (u: User) => {
  const res = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/social-accounts/facebook/connect`).set(auth(u));
  expect(res.status).toBe(200);
  return new URL(res.body.authorizationUrl).searchParams.get("state")!;
};
const facebookCallback = (query: Record<string, string>) => request(app).get(`/api/v1/integrations/facebook/callback?${new URLSearchParams(query)}`);
const connectFacebookViaOAuth = async (u: User) => facebookCallback({ code: "fb-good-code", state: await startFacebook(u) });

// ─── PKCE ───────────────────────────────────────────────────────────────────

describe("PKCE", () => {
  it("sends the challenge, keeps the verifier encrypted on the server, and uses it once", async () => {
    const u = await signUp();
    Object.assign(facebookAdapter, { usesPkce: true });
    try {
      const urlSpy = vi.spyOn(facebookAdapter, "getAuthorizationUrl");
      const connectSpy = vi.spyOn(facebookAdapter, "connect");
      const state = await startFacebook(u);

      const { codeChallenge } = urlSpy.mock.calls[0]![1]!;
      const stored = await prisma.oAuthConnectState.findFirstOrThrow();
      expect(stored.codeVerifierEnc).toMatch(/^v1:/);
      const verifier = decryptToken(stored.codeVerifierEnc!);
      expect(verifier).toMatch(/^[\w-]{43}$/);
      expect(stored.codeVerifierEnc).not.toContain(verifier);
      expect(codeChallenge).toBe(createHash("sha256").update(verifier).digest("base64url"));

      const res = await facebookCallback({ code: "fb-good-code", state });
      expect(res.headers.location).toContain("connected=facebook");
      expect(connectSpy).toHaveBeenCalledWith("fb-good-code", { codeVerifier: verifier });
      // Deleted once used; the callback can't be replayed.
      expect((await prisma.oAuthConnectState.findFirstOrThrow()).codeVerifierEnc).toBeNull();
      expect((await facebookCallback({ code: "fb-good-code", state })).headers.location).toContain("error=invalid_state");
    } finally {
      Object.assign(facebookAdapter, { usesPkce: undefined });
    }
  });

  it("refuses a PKCE platform's callback when the attempt has no verifier", async () => {
    const u = await signUp();
    const state = await startFacebook(u); // started before PKCE was switched on
    Object.assign(facebookAdapter, { usesPkce: true });
    try {
      expect((await facebookCallback({ code: "fb-good-code", state })).headers.location).toContain("error=invalid_state");
      expect(await prisma.socialAccount.count()).toBe(0);
    } finally {
      Object.assign(facebookAdapter, { usesPkce: undefined });
    }
  });

  it("isn't used by platforms that don't need it", async () => {
    const u = await signUp();
    await startFacebook(u);
    expect((await prisma.oAuthConnectState.findFirstOrThrow()).codeVerifierEnc).toBeNull();
  });
});

// ─── Key rotation ───────────────────────────────────────────────────────────

describe("encryption key rotation", () => {
  const key = () => randomBytes(32).toString("base64");
  const v1 = originalKeys.keys.get("v1")!.toString("base64");

  it("parses one key or a list, and rejects bad configurations", () => {
    expect(parseKeyRing(undefined, v1)).toMatchObject({ current: "v1" });
    const ring = parseKeyRing(`v2:${key()}, v1:${v1}`, undefined);
    expect(ring.current).toBe("v2");
    expect([...ring.keys.keys()]).toEqual(["v2", "v1"]);
    expect(() => parseKeyRing(`v2:${key()},v2:${key()}`, undefined)).toThrow("appears twice");
    expect(() => parseKeyRing("v2:c2hvcnQ=", undefined)).toThrow("32 bytes");
    expect(() => parseKeyRing(`two:${key()}`, undefined)).toThrow('look like "v2');
    expect(() => parseKeyRing(undefined, undefined)).toThrow("TOKEN_ENCRYPTION_KEY");
  });

  it("keeps old tokens readable, encrypts new ones with the new key, and re-encrypts the rest in the background", async () => {
    const u = await signUp();
    const account = await connectAccount(u); // token encrypted with v1
    const oldStored = (await prisma.oAuthToken.findUniqueOrThrow({ where: { socialAccountId: account.id } })).accessTokenEnc;
    expect(oldStored).toMatch(/^v1:/);

    env.tokenKeys = parseKeyRing(`v2:${key()},v1:${v1}`, undefined);
    expect(decryptToken(oldStored)).toBe("ig-token");
    expect(encryptToken("new")).toMatch(/^v2:/);
    expect(await keyVersionCounts()).toEqual({ v1: 1 });

    expect(await reencryptOldTokens()).toEqual({ tokens: 1, connectStates: 0 });
    const newStored = (await prisma.oAuthToken.findUniqueOrThrow({ where: { socialAccountId: account.id } })).accessTokenEnc;
    expect(newStored).toMatch(/^v2:/);
    expect(await keyVersionCounts()).toEqual({ v2: 1 });

    // Once nothing uses v1, it can be removed and everything still works.
    env.tokenKeys = parseKeyRing(`v2:${[...env.tokenKeys.keys.values()][0]!.toString("base64")}`, undefined);
    expect(decryptToken(newStored)).toBe("ig-token");
    expect(() => decryptToken(oldStored)).toThrow("Unrecognized");
    // Publishing still works with the re-encrypted token.
    const photo = await addMedia(u);
    await createPost(u, { caption: "After rotation", mediaIds: [photo.id], targets: [{ socialAccountId: account.id }] });
    expect(await runPublishCycle()).toEqual(["published"]);
  });

  it("never overwrites a token that changed after it was read", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const stale = await prisma.oAuthToken.findMany({ select: { socialAccountId: true, accessTokenEnc: true, refreshTokenEnc: true } });
    // Meanwhile the token is refreshed (still with v1).
    await prisma.oAuthToken.update({ where: { socialAccountId: account.id }, data: { accessTokenEnc: encryptToken("refreshed-token") } });

    env.tokenKeys = parseKeyRing(`v2:${key()},v1:${v1}`, undefined);
    vi.spyOn(prisma.oAuthToken, "findMany").mockResolvedValueOnce(stale as never);
    expect(await reencryptOldTokens()).toEqual({ tokens: 0, connectStates: 0 });
    const current = (await prisma.oAuthToken.findUniqueOrThrow({ where: { socialAccountId: account.id } })).accessTokenEnc;
    expect(decryptToken(current)).toBe("refreshed-token");
  });
});

// ─── Health checks ──────────────────────────────────────────────────────────

describe("daily connection health check", () => {
  it("confirms working accounts once a day and picks up profile changes", async () => {
    const u = await signUp();
    const ig = await connectAccount(u);
    const page = await connectPage(u);
    fake.profile.username = "brand_renamed";
    fb.pages[0]!.name = "Pune Cafe & Bakery";

    const now = new Date();
    expect(await runConnectionHealthChecks(now)).toEqual({ checked: 2, ok: 2, needsReauth: 0, skipped: 0 });
    expect(await prisma.socialAccount.findUniqueOrThrow({ where: { id: ig.id } })).toMatchObject({ username: "brand_renamed", lastCheckedAt: now, status: "ACTIVE" });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: page.id } })).name).toBe("Pune Cafe & Bakery");

    // Not again until a day later.
    expect((await runConnectionHealthChecks(new Date(now.getTime() + 23 * HOUR))).checked).toBe(0);
    expect((await runConnectionHealthChecks(new Date(now.getTime() + 25 * HOUR))).checked).toBe(2);
  });

  it("marks a revoked Page for reconnecting, which then warns about its scheduled posts", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    await createPost(u, { caption: "Tomorrow", targets: [{ socialAccountId: page.id }], scheduledAt: new Date(Date.now() + 5 * HOUR).toISOString() });
    fb.failures.push({ match: `GET ${FB_PAGE}`, status: 400, body: { error: { message: "Error validating access token: The user has not authorized application", code: 190 } } });

    expect(await runConnectionHealthChecks()).toMatchObject({ checked: 1, needsReauth: 1 });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: page.id } })).status).toBe("NEEDS_REAUTH");
    expect(await prisma.auditLog.count({ where: { action: "social_account.health_check_failed", targetId: page.id } })).toBe(1);
    expect(await runPreflightChecks()).toEqual({ warnedPosts: 1, targets: 1 });
    expect(testOutbox.at(-1)!.subject).toBe("A scheduled post needs your attention");
  });

  it("treats a lost Page role or permission like a rejected token", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    fb.failures.push({ match: `GET ${FB_PAGE}`, status: 400, body: { error: { message: "(#200) Requires pages_manage_posts permission", code: 200 } } });
    expect(await runConnectionHealthChecks()).toMatchObject({ needsReauth: 1 });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: page.id } })).status).toBe("NEEDS_REAUTH");
  });

  it("notices when a token belongs to a different Instagram account", async () => {
    const u = await signUp();
    const ig = await connectAccount(u);
    fake.profile.userId = "17841499999999999";
    expect(await runConnectionHealthChecks()).toMatchObject({ needsReauth: 1 });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: ig.id } })).status).toBe("NEEDS_REAUTH");
  });

  it("never blames the account for an outage or rate limit", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    fb.failures.push({ match: `GET ${FB_PAGE}`, status: 503, body: { error: { message: "Service temporarily unavailable", code: 2 } } });
    expect(await runConnectionHealthChecks()).toMatchObject({ checked: 1, skipped: 1, needsReauth: 0 });
    const after = await prisma.socialAccount.findUniqueOrThrow({ where: { id: page.id } });
    expect(after).toMatchObject({ status: "ACTIVE", lastCheckedAt: null }); // tried again next run
  });
});

// ─── One active workspace per account ───────────────────────────────────────

describe("one active workspace per account", () => {
  it("won't connect a Page that's active in another workspace, until it's disconnected there", async () => {
    const a = await signUp();
    const b = await signUp();
    expect((await connectFacebookViaOAuth(a)).headers.location).toContain("connected=facebook&count=1");

    const blocked = await connectFacebookViaOAuth(b);
    expect(blocked.headers.location).toBe(`${env.appUrl}/accounts?error=connected_elsewhere&platform=facebook`);
    expect(await prisma.socialAccount.count({ where: { workspaceId: b.workspaceId } })).toBe(0);

    // Reconnecting in its own workspace still works.
    expect((await connectFacebookViaOAuth(a)).headers.location).toContain("connected=facebook&count=1");

    const pageInA = await prisma.socialAccount.findFirstOrThrow({ where: { workspaceId: a.workspaceId } });
    await request(app).delete(`/api/v1/workspaces/${a.workspaceId}/social-accounts/${pageInA.id}`).set(auth(a)).send({});
    expect((await connectFacebookViaOAuth(b)).headers.location).toContain("connected=facebook&count=1");
  });

  it("connects the other Pages and says how many were already connected elsewhere", async () => {
    const a = await signUp();
    const b = await signUp();
    await connectFacebookViaOAuth(a);
    fb.pages.push({ id: "1000000000000002", name: "Second Page", access_token: "fb-page-token", tasks: ["CREATE_CONTENT"] });
    const res = await connectFacebookViaOAuth(b);
    expect(res.headers.location).toBe(`${env.appUrl}/accounts?connected=facebook&count=1&elsewhere=1`);
    expect((await prisma.socialAccount.findFirstOrThrow({ where: { workspaceId: b.workspaceId } })).externalId).toBe("1000000000000002");
  });

  it("is enforced by the database too", async () => {
    const a = await signUp();
    const b = await signUp();
    await connectPage(a);
    await expect(connectPage(b)).rejects.toMatchObject({ code: "P2002" });
    // A disconnected or revoked row doesn't count.
    await prisma.socialAccount.updateMany({ where: { workspaceId: a.workspaceId }, data: { status: "REVOKED" } });
    await expect(connectPage(b)).resolves.toMatchObject({ status: "ACTIVE" });
  });
});

// ─── Disconnecting with scheduled posts ─────────────────────────────────────

describe("disconnecting an account with scheduled posts", () => {
  const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
  const arrive = (postId: string) =>
    prisma.postTarget.updateMany({ where: { postId, status: "SCHEDULED" }, data: { scheduledAt: new Date(Date.now() - 60_000), nextAttemptAt: new Date(Date.now() - 60_000) } });

  async function setup() {
    const u = await signUp();
    const ig = await connectAccount(u);
    const page = await connectPage(u);
    const photo = await addMedia(u);
    const shared = (await createPost(u, { caption: "Both", mediaIds: [photo.id], targets: [{ socialAccountId: ig.id }, { socialAccountId: page.id }], scheduledAt: inHours(3) })).body.post;
    const solo = (await createPost(u, { caption: "Only Instagram", mediaIds: [photo.id], targets: [{ socialAccountId: ig.id }], scheduledAt: inHours(2) })).body.post;
    return { u, ig, page, shared, solo };
  }
  const url = (u: User, id: string) => `/api/v1/workspaces/${u.workspaceId}/social-accounts/${id}`;

  it("shows what would be affected", async () => {
    const { u, ig, solo } = await setup();
    const res = await request(app).get(`${url(u, ig.id)}/disconnect-impact`).set(auth(u));
    expect(res.body).toEqual({ scheduledPosts: 2, nextScheduledAt: solo.scheduledAt });
  });

  it("cancels only this account's part: other accounts still publish, and the post can still be edited", async () => {
    const { u, ig, page, shared, solo } = await setup();
    const res = await request(app).delete(url(u, ig.id)).set(auth(u)).send({ scheduledPosts: "cancel" });
    expect(res.body).toEqual({ cancelledTargets: 2 });

    const post = (id: string) => request(app).get(`/api/v1/workspaces/${u.workspaceId}/posts/${id}`).set(auth(u));
    expect((await post(solo.id)).body.post.status).toBe("CANCELLED");
    const sharedNow = (await post(shared.id)).body.post;
    expect(sharedNow.status).toBe("SCHEDULED");
    expect(sharedNow.targets.map((t: { account: { platform: string }; status: string }) => [t.account.platform, t.status])).toEqual([
      ["INSTAGRAM", "CANCELLED"],
      ["FACEBOOK", "SCHEDULED"],
    ]);

    const edited = await request(app).patch(`/api/v1/workspaces/${u.workspaceId}/posts/${shared.id}`).set(auth(u)).send({ caption: "Only Facebook now" });
    expect(edited.status).toBe(200);
    expect(edited.body.post.targets).toHaveLength(1);

    await arrive(shared.id);
    expect(await runPublishCycle()).toEqual(["published"]);
    expect((await post(shared.id)).body.post.status).toBe("PUBLISHED");
    expect(fb.posts[0]!.message).toBe("Only Facebook now");
    expect(await prisma.auditLog.findFirst({ where: { action: "social_account.disconnected", targetId: ig.id } })).toMatchObject({ metadata: { scheduledPosts: "cancel", cancelledTargets: 2 } });
    void page;
  });

  it("can keep them: they stay scheduled and fail clearly if the account isn't reconnected in time", async () => {
    const { u, ig, solo } = await setup();
    expect((await request(app).delete(url(u, ig.id)).set(auth(u)).send({ scheduledPosts: "keep" })).body).toEqual({ cancelledTargets: 0 });
    expect((await request(app).get(`/api/v1/workspaces/${u.workspaceId}/posts/${solo.id}`).set(auth(u))).body.post.status).toBe("SCHEDULED");
    await arrive(solo.id);
    expect(await runPublishCycle()).toContain("failed");
    expect(await prisma.postTarget.findFirstOrThrow({ where: { postId: solo.id } })).toMatchObject({ lastErrorCode: "ACCOUNT_NOT_CONNECTED" });
  });

  it("cancels by default, validates the choice, and leaves posts already publishing alone", async () => {
    const { u, ig, solo, shared } = await setup();
    await prisma.postTarget.updateMany({ where: { postId: solo.id }, data: { status: "PUBLISHING" } });
    expect((await request(app).delete(url(u, ig.id)).set(auth(u)).send({ scheduledPosts: "later" })).status).toBe(400);
    expect((await request(app).delete(url(u, ig.id)).set(auth(u))).body).toEqual({ cancelledTargets: 1 });
    expect((await prisma.postTarget.findFirstOrThrow({ where: { postId: solo.id } })).status).toBe("PUBLISHING");
    expect((await prisma.postTarget.findFirstOrThrow({ where: { postId: shared.id, socialAccountId: ig.id } })).status).toBe("CANCELLED");
  });
});
