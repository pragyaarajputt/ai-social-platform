import { prisma } from "../config/database.js";
import type { SocialPlatform } from "../generated/prisma/enums.js";
import { getAdapter } from "../integrations/registry.js";
import { PlatformApiError } from "../integrations/types.js";
import { AppError } from "../utils/AppError.js";
import { generateToken, hashToken } from "../utils/crypto.js";
import { encryptToken } from "../utils/tokenCrypto.js";
import { audit } from "./audit.service.js";

const CONNECT_STATE_TTL_MS = 10 * 60_000;

/** Why a connect attempt failed. Sent to the frontend as ?error=<reason> after the redirect. */
export type ConnectFailure =
  | "cancelled" // the user said no on the platform's consent screen
  | "invalid_state" // unknown, used or expired state: not a flow we started, or it took too long
  | "unsupported_account" // e.g. a personal Instagram account
  | "no_accounts" // e.g. no Facebook Page chosen, or none the user can post to
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
  await prisma.oAuthConnectState.create({
    data: {
      stateHash: hashToken(state),
      userId: params.userId,
      workspaceId: params.workspaceId,
      platform: params.platform,
      expiresAt: new Date(Date.now() + CONNECT_STATE_TTL_MS),
    },
  });
  return { authorizationUrl: adapter.getAuthorizationUrl(state) };
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
    data: { usedAt: new Date() },
  });
  if (!stored || count === 0) throw new ConnectError("invalid_state", "Unknown, used or expired state");

  if (params.error) throw new ConnectError("cancelled", "The user declined access");
  if (!params.code) throw new ConnectError("platform_error", "No authorization code");

  let grants;
  try {
    grants = await adapter.connect(params.code);
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

  // All granted accounts are saved together, so a login never half-connects.
  return prisma.$transaction(async (tx) => {
    const accounts = [];
    for (const { profile, tokens } of supported) {
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
      const key = { workspaceId, platform: params.platform, externalId: profile.externalId };
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
          metadata: { platform: params.platform, username: account.username ?? "" },
        },
        tx,
      );
      accounts.push(account);
    }
    return { workspaceId, accounts };
  });
}

export async function disconnectSocialAccount(params: { workspaceId: string; accountId: string; actorId: string }) {
  const account = await prisma.socialAccount.findFirst({
    where: { id: params.accountId, workspaceId: params.workspaceId, status: { not: "DISCONNECTED" } },
    select: { id: true, platform: true, username: true },
  });
  if (!account) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Connected account not found");

  await prisma.$transaction(async (tx) => {
    await tx.oAuthToken.deleteMany({ where: { socialAccountId: account.id } });
    await tx.socialAccount.update({ where: { id: account.id }, data: { status: "DISCONNECTED" } });
    await audit(
      {
        action: "social_account.disconnected",
        workspaceId: params.workspaceId,
        actorId: params.actorId,
        targetType: "social_account",
        targetId: account.id,
        metadata: { platform: account.platform, username: account.username ?? "" },
      },
      tx,
    );
  });
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
