import { randomBytes } from "node:crypto";
import { env } from "../config/env.js";
import { prisma } from "../config/database.js";
import { Prisma } from "../generated/prisma/client.js";
import type { WorkspaceRole } from "../generated/prisma/enums.js";
import type { AssignableRole } from "../schemas/team.schemas.js";
import { AppError } from "../utils/AppError.js";
import { generateToken, hashToken } from "../utils/crypto.js";
import { verifyPassword } from "../utils/password.js";
import { audit } from "./audit.service.js";
import { sendWorkspaceInvite } from "./email.service.js";
import { disconnectSocialAccount } from "./socialAccount.service.js";
import { hasRole } from "./workspace.service.js";

// Workspaces, members and invites.
//
// Rules: a workspace always has exactly one OWNER, and ownership only changes hands through a
// transfer. Nobody changes their own role. Admins manage Editors and Viewers (and may make someone an
// Admin), but can't change or remove other Admins or the Owner. Changes to membership lock the
// workspace row, so two of them can never interleave (e.g. two Owners after concurrent changes).

export const INVITE_TTL_MS = 7 * 86_400_000;
const INVITES_PER_HOUR = 20;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_OWNED_WORKSPACES = 20;

interface Actor {
  userId: string;
  role: WorkspaceRole;
}

/** Locks the workspace row for the rest of the transaction; see the rules above. */
async function lockWorkspace(tx: Prisma.TransactionClient, workspaceId: string) {
  const [row] = await tx.$queryRaw<{ id: string; name: string }[]>`SELECT id, name FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE`;
  if (!row) throw new AppError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
  return row;
}

/** Re-reads a membership inside the transaction, so decisions use the locked, current state. */
async function membership(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
  return tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { role: true } });
}

/** Deleting or giving away a workspace: its exact name, plus the password when the account has one. */
async function confirmIdentity(userId: string, workspaceName: string, input: { confirmName: string; password?: string }) {
  if (input.confirmName.trim() !== workspaceName) {
    throw new AppError(400, "CONFIRMATION_MISMATCH", "Type the workspace name exactly as shown to confirm.");
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
  if (user.passwordHash && !(input.password && (await verifyPassword(user.passwordHash, input.password)))) {
    throw new AppError(403, "WRONG_PASSWORD", "That password isn't right.");
  }
}

// ─── Workspaces ─────────────────────────────────────────────────────────────

export async function createWorkspace(userId: string, name: string) {
  const owned = await prisma.workspaceMember.count({ where: { userId, role: "OWNER" } });
  if (owned >= MAX_OWNED_WORKSPACES) throw new AppError(409, "WORKSPACE_LIMIT", `You can own at most ${MAX_OWNED_WORKSPACES} workspaces.`);
  const workspace = await prisma.workspace.create({
    data: {
      name,
      slug: `ws-${randomBytes(6).toString("hex")}`,
      members: { create: { userId, role: "OWNER" } },
    },
  });
  await audit({ action: "workspace.created", workspaceId: workspace.id, actorId: userId });
  return { id: workspace.id, name: workspace.name, slug: workspace.slug, timezone: workspace.timezone, isPersonal: false, role: "OWNER" as const };
}

export async function renameWorkspace(workspaceId: string, actorId: string, name: string) {
  await prisma.workspace.update({ where: { id: workspaceId }, data: { name } });
  await audit({ action: "workspace.renamed", workspaceId, actorId, metadata: { name } });
}

export async function deleteWorkspace(workspaceId: string, actorId: string, input: { confirmName: string; password?: string }) {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  await confirmIdentity(actorId, workspace.name, input);
  if ((await prisma.workspaceMember.count({ where: { userId: actorId } })) <= 1) {
    throw new AppError(409, "LAST_WORKSPACE", "You can't delete your only workspace. Create another one first.");
  }
  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    // Don't pull the rows out from under a post that is being published right now.
    const busy = await tx.postTarget.count({
      where: { post: { workspaceId }, status: { in: ["PUBLISHING", "WAITING_FOR_MEDIA"] } },
    });
    if (busy) throw new AppError(409, "PUBLISHING_IN_PROGRESS", "Posts in this workspace are being published right now. Try again in a few minutes.");
    // Posts, media, connected accounts (and their tokens), invites and memberships go with it.
    await tx.workspace.delete({ where: { id: workspaceId } });
  });
  await audit({ action: "workspace.deleted", actorId, metadata: { workspaceId, name: workspace.name } });
}

// ─── Members ────────────────────────────────────────────────────────────────

export async function listMembers(workspaceId: string, viewer: Actor) {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    select: {
      role: true,
      createdAt: true,
      user: { select: { id: true, username: true, email: true, profile: { select: { displayName: true } } } },
    },
  });
  const connected = await prisma.socialAccount.groupBy({
    by: ["connectedById"],
    where: { workspaceId, status: { not: "DISCONNECTED" }, connectedById: { in: members.map((m) => m.user.id) } },
    _count: true,
  });
  const connectedBy = new Map(connected.map((c) => [c.connectedById, c._count]));
  // Email addresses are personal: only people who manage the team see them.
  const seeEmails = hasRole(viewer.role, "ADMIN");
  return members.map((m) => ({
    userId: m.user.id,
    username: m.user.username,
    displayName: m.user.profile?.displayName ?? m.user.username,
    email: seeEmails || m.user.id === viewer.userId ? m.user.email : null,
    role: m.role,
    joinedAt: m.createdAt,
    connectedAccounts: connectedBy.get(m.user.id) ?? 0,
  }));
}

/** Whether `actor` may change or remove the member `target`. */
function canManage(actor: Actor, targetUserId: string, targetRole: WorkspaceRole): string | null {
  if (targetUserId === actor.userId) return "You can't change your own role or remove yourself here.";
  if (targetRole === "OWNER") return "The owner can't be changed or removed. The owner can transfer ownership instead.";
  if (targetRole === "ADMIN" && actor.role !== "OWNER") return "Only the owner can change or remove admins.";
  return null;
}

export async function changeRole(workspaceId: string, actor: Actor, targetUserId: string, role: AssignableRole) {
  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const me = await membership(tx, workspaceId, actor.userId);
    const target = await membership(tx, workspaceId, targetUserId);
    if (!target) throw new AppError(404, "MEMBER_NOT_FOUND", "That person isn't a member of this workspace.");
    const problem = me ? canManage({ ...actor, role: me.role }, targetUserId, target.role) : "You're no longer a member of this workspace.";
    if (problem) throw new AppError(403, "INSUFFICIENT_ROLE", problem);
    if (target.role === role) return;
    await tx.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: targetUserId } }, data: { role } });
    await audit({ action: "workspace.member_role_changed", workspaceId, actorId: actor.userId, targetType: "user", targetId: targetUserId, metadata: { from: target.role, to: role } }, tx);
  });
}

/**
 * Removes a member. Their posts and media stay (they belong to the workspace). Accounts they connected
 * use tokens issued to *their* login, so by default those are disconnected too.
 */
export async function removeMember(workspaceId: string, actor: Actor, targetUserId: string, disconnectAccounts: boolean) {
  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const me = await membership(tx, workspaceId, actor.userId);
    const target = await membership(tx, workspaceId, targetUserId);
    if (!target) throw new AppError(404, "MEMBER_NOT_FOUND", "That person isn't a member of this workspace.");
    const problem = me ? canManage({ ...actor, role: me.role }, targetUserId, target.role) : "You're no longer a member of this workspace.";
    if (problem) throw new AppError(403, "INSUFFICIENT_ROLE", problem);
    await tx.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: targetUserId } } });
    await audit({ action: "workspace.member_removed", workspaceId, actorId: actor.userId, targetType: "user", targetId: targetUserId, metadata: { disconnectAccounts } }, tx);
  });
  let disconnected = 0;
  if (disconnectAccounts) {
    const accounts = await prisma.socialAccount.findMany({
      where: { workspaceId, connectedById: targetUserId, status: { not: "DISCONNECTED" } },
      select: { id: true },
    });
    for (const a of accounts) {
      await disconnectSocialAccount({ workspaceId, accountId: a.id, actorId: actor.userId, scheduledPosts: "cancel" });
      disconnected += 1;
    }
  }
  return { disconnectedAccounts: disconnected };
}

export async function leaveWorkspace(workspaceId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const me = await membership(tx, workspaceId, userId);
    if (!me) throw new AppError(404, "WORKSPACE_NOT_FOUND", "Workspace not found");
    if (me.role === "OWNER") {
      throw new AppError(409, "OWNER_CANT_LEAVE", "Transfer ownership to someone else first, or delete the workspace.");
    }
    await tx.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId } } });
    await audit({ action: "workspace.member_left", workspaceId, actorId: userId, targetType: "user", targetId: userId }, tx);
  });
}

export async function transferOwnership(workspaceId: string, ownerId: string, input: { userId: string; confirmName: string; password?: string }) {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  await confirmIdentity(ownerId, workspace.name, input);
  if (input.userId === ownerId) throw new AppError(400, "VALIDATION_ERROR", "You're already the owner.");
  await prisma.$transaction(async (tx) => {
    await lockWorkspace(tx, workspaceId);
    const me = await membership(tx, workspaceId, ownerId);
    if (me?.role !== "OWNER") throw new AppError(403, "INSUFFICIENT_ROLE", "Only the owner can transfer ownership.");
    const target = await membership(tx, workspaceId, input.userId);
    if (!target) throw new AppError(404, "MEMBER_NOT_FOUND", "That person isn't a member of this workspace.");
    await tx.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: input.userId } }, data: { role: "OWNER" } });
    await tx.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: ownerId } }, data: { role: "ADMIN" } });
    await audit({ action: "workspace.ownership_transferred", workspaceId, actorId: ownerId, targetType: "user", targetId: input.userId }, tx);
  });
}

// ─── Invites ────────────────────────────────────────────────────────────────

/** "p***@example.com": enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local!.slice(0, 1)}***@${domain}`;
}

const inviteLink = (token: string) => `${env.appUrl}/invite/${token}`;
type InviteState = "pending" | "expired" | "accepted" | "revoked";
const stateOf = (i: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now = new Date()): InviteState =>
  i.acceptedAt ? "accepted" : i.revokedAt ? "revoked" : i.expiresAt <= now ? "expired" : "pending";

async function inviterName(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, profile: { select: { displayName: true } } } });
  return u?.profile?.displayName ?? u?.username ?? "Someone";
}

/**
 * Invites someone by email, or refreshes their pending invite (new link, new expiry, new role).
 * Returns the link too, so admins can send it themselves; only its hash is stored.
 */
export async function createInvite(workspaceId: string, actor: Actor, input: { email: string; role: AssignableRole }) {
  if (input.role === "ADMIN" && !hasRole(actor.role, "ADMIN")) throw new AppError(403, "INSUFFICIENT_ROLE", "Only admins can invite admins.");
  const existingMember = await prisma.workspaceMember.findFirst({ where: { workspaceId, user: { email: input.email } } });
  if (existingMember) throw new AppError(409, "ALREADY_MEMBER", "That person is already a member of this workspace.");

  const now = new Date();
  const sentLastHour = await prisma.auditLog.count({ where: { workspaceId, action: "workspace.invite_sent", createdAt: { gt: new Date(now.getTime() - 3_600_000) } } });
  if (sentLastHour >= INVITES_PER_HOUR) throw new AppError(429, "TOO_MANY_INVITES", "This workspace has sent a lot of invites in the last hour. Try again later.");

  const token = generateToken();
  const data = { role: input.role, tokenHash: hashToken(token), invitedById: actor.userId, expiresAt: new Date(now.getTime() + INVITE_TTL_MS), lastSentAt: now };
  const pending = await prisma.workspaceInvite.findFirst({ where: { workspaceId, email: input.email, acceptedAt: null, revokedAt: null } });
  if (pending && now.getTime() - pending.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new AppError(429, "RESEND_TOO_SOON", "This invite was just sent. Wait a minute before sending it again.");
  }
  let invite;
  try {
    invite = pending
      ? await prisma.workspaceInvite.update({ where: { id: pending.id }, data })
      : await prisma.workspaceInvite.create({ data: { ...data, workspaceId, email: input.email } });
  } catch (err) {
    // Two admins inviting the same email at the same moment: the unique index keeps one.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new AppError(409, "INVITE_EXISTS", "An invite for this email was just created. Refresh and resend it if needed.");
    }
    throw err;
  }
  await audit({ action: "workspace.invite_sent", workspaceId, actorId: actor.userId, metadata: { email: input.email, role: input.role, resent: Boolean(pending) } });

  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true } });
  await sendWorkspaceInvite(input.email, {
    workspaceName: workspace.name,
    inviterName: await inviterName(actor.userId),
    role: input.role,
    link: inviteLink(token),
    expiresAt: invite.expiresAt,
  });
  return { invite: toPublicInvite(invite), link: inviteLink(token) };
}

function toPublicInvite(i: { id: string; email: string; role: WorkspaceRole; expiresAt: Date; lastSentAt: Date; createdAt: Date; acceptedAt: Date | null; revokedAt: Date | null }) {
  return { id: i.id, email: i.email, role: i.role, state: stateOf(i), expiresAt: i.expiresAt, lastSentAt: i.lastSentAt, createdAt: i.createdAt };
}

export async function listInvites(workspaceId: string) {
  const invites = await prisma.workspaceInvite.findMany({ where: { workspaceId, acceptedAt: null, revokedAt: null }, orderBy: { createdAt: "desc" } });
  return invites.map(toPublicInvite);
}

export async function resendInvite(workspaceId: string, actor: Actor, inviteId: string) {
  const invite = await prisma.workspaceInvite.findFirst({ where: { id: inviteId, workspaceId, acceptedAt: null, revokedAt: null } });
  if (!invite) throw new AppError(404, "INVITE_NOT_FOUND", "Invite not found");
  return createInvite(workspaceId, actor, { email: invite.email, role: invite.role as AssignableRole });
}

export async function revokeInvite(workspaceId: string, actorId: string, inviteId: string) {
  const { count } = await prisma.workspaceInvite.updateMany({ where: { id: inviteId, workspaceId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
  if (count === 0) throw new AppError(404, "INVITE_NOT_FOUND", "Invite not found");
  await audit({ action: "workspace.invite_revoked", workspaceId, actorId, targetType: "invite", targetId: inviteId });
}

/** What the invite page shows before signing in. Nothing sensitive: the email is masked. */
export async function previewInvite(token: string) {
  const invite = await prisma.workspaceInvite.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { workspace: { select: { name: true } } },
  });
  if (!invite) throw new AppError(404, "INVITE_NOT_FOUND", "This invite link isn't valid.");
  return {
    workspaceName: invite.workspace.name,
    inviterName: invite.invitedById ? await inviterName(invite.invitedById) : "Someone",
    role: invite.role,
    email: maskEmail(invite.email),
    state: stateOf(invite),
    expiresAt: invite.expiresAt,
  };
}

/** Joins the workspace. Only the invited person: signed in with the same, verified, email address. */
export async function acceptInvite(token: string, userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
  return prisma.$transaction(async (tx) => {
    const [invite] = await tx.$queryRaw<
      { id: string; workspace_id: string; email: string; role: WorkspaceRole; expires_at: Date; accepted_at: Date | null; accepted_by_id: string | null; revoked_at: Date | null }[]
    >`SELECT id, workspace_id, email, role, expires_at, accepted_at, accepted_by_id, revoked_at FROM workspace_invites WHERE token_hash = ${hashToken(token)} FOR UPDATE`;
    if (!invite) throw new AppError(404, "INVITE_NOT_FOUND", "This invite link isn't valid.");
    // Accepting twice (double click, second tab) just lands in the workspace.
    if (invite.accepted_at && invite.accepted_by_id === userId) return { workspaceId: invite.workspace_id };
    const state = stateOf({ acceptedAt: invite.accepted_at, revokedAt: invite.revoked_at, expiresAt: invite.expires_at });
    if (state === "accepted") throw new AppError(410, "INVITE_USED", "This invite has already been used.");
    if (state === "revoked") throw new AppError(410, "INVITE_REVOKED", "This invite was withdrawn. Ask for a new one.");
    if (state === "expired") throw new AppError(410, "INVITE_EXPIRED", "This invite has expired. Ask for a new one.");
    if (user.email !== invite.email) {
      throw new AppError(403, "INVITE_EMAIL_MISMATCH", `This invite is for ${maskEmail(invite.email)}. Sign in with that email address to accept it.`);
    }
    if (!user.emailVerifiedAt) throw new AppError(403, "EMAIL_NOT_VERIFIED", "Verify your email address first, then accept the invite.");

    await lockWorkspace(tx, invite.workspace_id);
    const already = await membership(tx, invite.workspace_id, userId);
    if (!already) await tx.workspaceMember.create({ data: { workspaceId: invite.workspace_id, userId, role: invite.role } });
    await tx.workspaceInvite.update({ where: { id: invite.id }, data: { acceptedAt: new Date(), acceptedById: userId } });
    await audit({ action: "workspace.invite_accepted", workspaceId: invite.workspace_id, actorId: userId, targetType: "invite", targetId: invite.id, metadata: { role: invite.role } }, tx);
    return { workspaceId: invite.workspace_id };
  });
}
