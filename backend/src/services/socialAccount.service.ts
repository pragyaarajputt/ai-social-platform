import { prisma } from "../config/database.js";
import type { SocialPlatform } from "../generated/prisma/enums.js";
import { getAdapter } from "../integrations/registry.js";
import { PlatformApiError, type ConnectedAccountGrant } from "../integrations/types.js";
import { AppError } from "../utils/AppError.js";
import { Prisma } from "../generated/prisma/client.js";
import { createPkcePair, generateToken, hashToken } from "../utils/crypto.js";
import { decryptToken, encryptToken } from "../utils/tokenCrypto.js";
import { refreshPostStatus } from "../jobs/publishQueue.js";
import { audit } from "./audit.service.js";

const CONNECT_STATE_TTL_MS = 10 * 60_000;

/** Why a connect attempt failed. Sent to the frontend as ?error=<reason> after the redirect. */
export type ConnectFailure =
  | "cancelled" // the user said no on the platform's consent screen
  | "invalid_state" // unknown, used or expired state: not a flow we started, or it took too long
  | "unsupported_account" // e.g. a personal Instagram account
  | "no_accounts" // e.g. no Facebook Page chosen, or none the user can post to
  | "connected_elsewhere" // every granted account is already active in another workspace
  | "platform_error"; // the platform rejected the code or was unavailable

export class ConnectError extends Error {
  constructor(
    public readonly reason: ConnectFailure,
    message: string,
  ) {
    super(message);
  }
}

// Never select token columns here: this shape goes to the browser.
const publicAccountSelect = {
  id: true,
  platform: true,
  externalId: true,
  accountType: true,
  username: true,
  name: true,
  avatarUrl: true,
  status: true,
  insightsAllowed: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true,
  token: { select: { expiresAt: true, lastRefreshedAt: true } },
} as const;

export async function listSocialAccounts(workspaceId: string) {
  const accounts = await prisma.socialAccount.findMany({
    where: { workspaceId, status: { not: "DISCONNECTED" } },
    orderBy: { createdAt: "asc" },
    select: publicAccountSelect,
  });
  return accounts.map(({ token, ...a }) => ({
    ...a,
    tokenExpiresAt: token?.expiresAt ?? null,
    tokenRefreshedAt: token?.lastRefreshedAt ?? null,
  }));
}

/** Starts the OAuth flow: remembers who is connecting, and returns the platform's consent URL. */
export async function startConnect(params: { userId: string; workspaceId: string; platform: SocialPlatform }) {
  const adapter = getAdapter(params.platform);
  if (!adapter.isConfigured()) {
    throw new AppError(501, "NOT_CONFIGURED", `${adapter.capabilities.displayName} isn't set up on this server yet`);
  }
  const state = generateToken();
  const pkce = adapter.usesPkce ? createPkcePair() : null;
  await prisma.oAuthConnectState.create({
    data: {
      stateHash: hashToken(state),
      userId: params.userId,
      workspaceId: params.workspaceId,
      platform: params.platform,
      // The verifier never leaves the server; only its hash goes in the consent URL.
      codeVerifierEnc: pkce ? encryptToken(pkce.codeVerifier) : null,
      expiresAt: new Date(Date.now() + CONNECT_STATE_TTL_MS),
    },
  });
  return { authorizationUrl: adapter.getAuthorizationUrl(state, pkce ? { codeChallenge: pkce.codeChallenge } : undefined) };
}

/** Finishes the OAuth flow after the platform redirects back. */
export async function completeConnect(params: {
  platform: SocialPlatform;
  code?: string;
  state?: string;
  error?: string;
}) {
  const adapter = getAdapter(params.platform);
  if (!params.state) throw new ConnectError("invalid_state", "Missing state");

  // Consume the state first, so a callback URL can never be replayed.
  const stateHash = hashToken(params.state);
  const stored = await prisma.oAuthConnectState.findUnique({ where: { stateHash } });
  const { count } = await prisma.oAuthConnectState.updateMany({
    where: { stateHash, platform: params.platform, usedAt: null, expiresAt: { gt: new Date() } },
    // The verifier is only needed once; don't keep it around.
    data: { usedAt: new Date(), codeVerifierEnc: null },
  });
  if (!stored || count === 0) throw new ConnectError("invalid_state", "Unknown, used or expired state");
  const codeVerifier = stored.codeVerifierEnc ? decryptToken(stored.codeVerifierEnc) : undefined;
  if (adapter.usesPkce && !codeVerifier) throw new ConnectError("invalid_state", "No PKCE verifier for this state");

  if (params.error) throw new ConnectError("cancelled", "The user declined access");
  if (!params.code) throw new ConnectError("platform_error", "No authorization code");

  let grants;
  try {
    grants = await adapter.connect(params.code, codeVerifier ? { codeVerifier } : undefined);
  } catch (err) {
    if (err instanceof PlatformApiError) throw new ConnectError("platform_error", err.message);
    throw err;
  }

  // Only account types the platform lets us publish to (e.g. not personal Instagram accounts).
  const supported = grants.filter((g) => adapter.capabilities.supportedAccountTypes.includes(g.profile.accountType));
  if (supported.length === 0) {
    if (grants.length === 0) throw new ConnectError("no_accounts", "The user granted no accounts we can publish to");
    throw new ConnectError("unsupported_account", `Account type ${grants[0]!.profile.accountType} can't be connected`);
  }

  const { workspaceId, userId } = stored;
  const now = new Date();

  // An account can be active in only one workspace (also enforced by a unique index). Accounts
  // active elsewhere are skipped; which workspace has them is not revealed.
  const elsewhere = await prisma.socialAccount.findMany({
    where: {
      platform: params.platform,
      externalId: { in: supported.map((g) => g.profile.externalId) },
      workspaceId: { not: workspaceId },
      status: { in: ["ACTIVE", "NEEDS_REAUTH"] },
    },
    select: { externalId: true },
  });
  const takenElsewhere = new Set(elsewhere.map((a) => a.externalId));
  const connectable = supported.filter((g) => !takenElsewhere.has(g.profile.externalId));
  if (connectable.length === 0) {
    throw new ConnectError("connected_elsewhere", "Every granted account is already connected to another workspace");
  }

  // All granted accounts are saved together, so a login never half-connects.
  try {
    return await saveConnectedAccounts(params.platform, adapter, workspaceId, userId, connectable, now, takenElsewhere.size);
  } catch (err) {
    // Another workspace connected the same account a moment ago: the unique index stops the second one.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new ConnectError("connected_elsewhere", "The account was just connected to another workspace");
    }
    throw err;
  }
}

async function saveConnectedAccounts(
  platform: SocialPlatform,
  adapter: ReturnType<typeof getAdapter>,
  workspaceId: string,
  userId: string,
  grants: ConnectedAccountGrant[],
  now: Date,
  skippedElsewhere: number,
) {
  return prisma.$transaction(async (tx) => {
    const accounts = [];
    for (const { profile, tokens } of grants) {
      const tokenData = {
        accessTokenEnc: encryptToken(tokens.accessToken),
        refreshTokenEnc: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
        expiresAt: tokens.expiresAt ?? null,
        scopes: tokens.scopes,
        lastRefreshedAt: now,
        failureCount: 0,
        lastError: null,
      };
      const accountData = {
        appScopedId: profile.appScopedId ?? null,
        accountType: profile.accountType,
        username: profile.username ?? null,
        name: profile.name ?? null,
        avatarUrl: profile.avatarUrl ?? null,
        status: "ACTIVE" as const,
        // Reconnecting with the insights permission turns analytics (back) on.
        insightsAllowed: adapter.insights ? tokens.scopes.includes(adapter.insights.requiredScope) : false,
        connectedById: userId,
        lastCheckedAt: now,
      };
      const key = { workspaceId, platform, externalId: profile.externalId };
      const existing = await tx.socialAccount.findUnique({
        where: { workspaceId_platform_externalId: key },
        select: { id: true },
      });
      // Reconnecting an account updates it in place instead of creating a duplicate.
      const account = await tx.socialAccount.upsert({
        where: { workspaceId_platform_externalId: key },
        create: { ...key, ...accountData, token: { create: tokenData } },
        update: { ...accountData, token: { upsert: { create: tokenData, update: tokenData } } },
        select: publicAccountSelect,
      });
      await audit(
        {
          action: existing ? "social_account.reconnected" : "social_account.connected",
          workspaceId,
          actorId: userId,
          targetType: "social_account",
          targetId: account.id,
          metadata: { platform, username: account.username ?? "" },
        },
        tx,
      );
      accounts.push(account);
    }
    return { workspaceId, accounts, skippedElsewhere };
  });
}

async function findConnectedAccount(workspaceId: string, accountId: string) {
  const account = await prisma.socialAccount.findFirst({
    where: { id: accountId, workspaceId, status: { not: "DISCONNECTED" } },
    select: { id: true, platform: true, username: true },
  });
  if (!account) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Connected account not found");
  return account;
}

/** What disconnecting would affect: scheduled posts that use this account. */
export async function getDisconnectImpact(workspaceId: string, accountId: string) {
  const account = await findConnectedAccount(workspaceId, accountId);
  const targets = await prisma.postTarget.findMany({
    where: { socialAccountId: account.id, status: "SCHEDULED" },
    select: { scheduledAt: true },
    orderBy: { scheduledAt: "asc" },
  });
  return { scheduledPosts: targets.length, nextScheduledAt: targets[0]?.scheduledAt ?? null };
}

/**
 * Disconnects an account: its tokens are deleted and it can't publish. Scheduled posts that use it
 * either lose this account ("cancel": the rest of each post still goes out) or are left as they are
 * ("keep": they publish if the account is reconnected in time, otherwise they fail with a clear reason).
 */
export async function disconnectSocialAccount(params: { workspaceId: string; accountId: string; actorId: string; scheduledPosts: "cancel" | "keep" }) {
  const account = await findConnectedAccount(params.workspaceId, params.accountId);

  const cancelled = await prisma.$transaction(async (tx) => {
    let rows: { id: string; post_id: string }[] = [];
    if (params.scheduledPosts === "cancel") {
      // Locked, like editing a post: the worker claims with SKIP LOCKED, so it can't start one of
      // these while we cancel it, and anything it already started isn't SCHEDULED any more.
      rows = await tx.$queryRaw<{ id: string; post_id: string }[]>`
        SELECT id, post_id FROM post_targets
        WHERE social_account_id = ${account.id}::uuid AND status = 'SCHEDULED'
        FOR UPDATE`;
      if (rows.length) {
        await tx.postTarget.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: "CANCELLED", nextAttemptAt: null } });
      }
    }
    await tx.oAuthToken.deleteMany({ where: { socialAccountId: account.id } });
    await tx.socialAccount.update({ where: { id: account.id }, data: { status: "DISCONNECTED" } });
    await audit(
      {
        action: "social_account.disconnected",
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        targetType: "social_account",
        targetId: account.id,
        metadata: { platform: account.platform, username: account.username ?? "", scheduledPosts: params.scheduledPosts, cancelledTargets: rows.length },
      },
      tx,
    );
    return rows;
  });

  // Each affected post keeps going for its other accounts, or becomes cancelled if none are left.
  for (const postId of new Set(cancelled.map((r) => r.post_id))) await refreshPostStatus(postId);
  return { cancelledTargets: cancelled.length };
}

/** The user removed our app on the platform: stop using their tokens everywhere. */
export async function handleDeauthorize(platform: SocialPlatform, appScopedId: string): Promise<number> {
  const accounts = await prisma.socialAccount.findMany({
    where: { platform, appScopedId },
    select: { id: true, workspaceId: true },
  });
  for (const a of accounts) {
    await prisma.$transaction(async (tx) => {
      await tx.oAuthToken.deleteMany({ where: { socialAccountId: a.id } });
      await tx.socialAccount.update({ where: { id: a.id }, data: { status: "REVOKED" } });
      await audit(
        { action: "social_account.revoked_by_platform", workspaceId: a.workspaceId, targetType: "social_account", targetId: a.id },
        tx,
      );
    });
  }
  return accounts.length;
}

/** The user asked the platform to have us delete their data: remove the accounts and tokens entirely. */
export async function handleDataDeletion(platform: SocialPlatform, appScopedId: string): Promise<string> {
  const confirmationCode = generateToken().slice(0, 16);
  const accounts = await prisma.socialAccount.findMany({
    where: { platform, appScopedId },
    select: { id: true, workspaceId: true },
  });
  await prisma.$transaction(async (tx) => {
    // Tokens are deleted by the cascade from social_accounts.
    await tx.socialAccount.deleteMany({ where: { id: { in: accounts.map((a) => a.id) } } });
    await audit(
      {
        action: "social_account.data_deleted",
        metadata: { platform, confirmationCode, accountsDeleted: accounts.length },
      },
      tx,
    );
  });
  return confirmationCode;
}

export async function getDataDeletionStatus(confirmationCode: string) {
  const entry = await prisma.auditLog.findFirst({
    where: { action: "social_account.data_deleted", metadata: { path: ["confirmationCode"], equals: confirmationCode } },
    select: { createdAt: true },
  });
  return entry ? { status: "completed" as const, completedAt: entry.createdAt } : null;
}
