import { prisma } from "../config/database.js";
import type { SocialPlatform } from "../generated/prisma/enums.js";
import { getAdapter } from "../integrations/registry.js";
import { PlatformApiError } from "../integrations/types.js";
import { decryptToken, encryptToken } from "../utils/tokenCrypto.js";
import { audit } from "./audit.service.js";

/** Refresh tokens that expire within this window. */
const REFRESH_WINDOW_MS = 10 * 86_400_000;
/** After this many failed refreshes in a row, ask the user to reconnect. */
const MAX_FAILURES = 3;

export interface RefreshSummary {
  checked: number;
  refreshed: number;
  skipped: number;
  failed: number;
  needsReauth: number;
}

/**
 * Keeps connected accounts working by refreshing tokens before they expire. Run by the worker.
 * A token that can't be refreshed marks its account NEEDS_REAUTH, so the UI can ask for a reconnect
 * instead of a scheduled post failing later.
 */
export async function refreshDueTokens(now = new Date()): Promise<RefreshSummary> {
  const due = await prisma.oAuthToken.findMany({
    where: {
      expiresAt: { lt: new Date(now.getTime() + REFRESH_WINDOW_MS) },
      socialAccount: { status: "ACTIVE" },
    },
    include: { socialAccount: { select: { id: true, workspaceId: true, platform: true, externalId: true } } },
  });

  const summary: RefreshSummary = { checked: due.length, refreshed: 0, skipped: 0, failed: 0, needsReauth: 0 };

  for (const token of due) {
    const account = token.socialAccount;
    const adapter = getAdapter(account.platform);

    const hasRefreshToken = token.refreshTokenEnc !== null;
    if (token.expiresAt && token.expiresAt <= now && !(adapter.refreshTokenOutlivesAccessToken && hasRefreshToken)) {
      await markNeedsReauth(account, "Token expired before it could be refreshed");
      summary.needsReauth++;
      continue;
    }
    const notBefore = adapter.refreshableAfter?.(token.lastRefreshedAt ?? token.createdAt);
    const renewable = adapter.canRefresh?.({ hasRefreshToken }) ?? true;
    if (!renewable || (notBefore && notBefore > now)) {
      summary.skipped++;
      continue;
    }

    const outcome = await refreshAccountToken(account, now);
    if (outcome === "refreshed" || outcome === "fresh") summary.refreshed++;
    else if (outcome === "failed") summary.failed++;
    else summary.needsReauth++;
  }
  return summary;
}

export type RefreshOutcome = "refreshed" | "fresh" | "failed" | "needs_reauth";

/**
 * Refreshes one account's token. With `unlessValidFor`, does nothing if the token is still valid for at
 * least that long (it may have just been refreshed by someone else).
 *
 * Platforms like X hand out a new refresh token on every refresh and invalidate the old one. Two
 * refreshes of the same account at once (the hourly job and a post being published) would both present
 * the same refresh token, and the loser would be rejected and wrongly ask the user to reconnect. So
 * refreshes of one account take a transaction-scoped Postgres advisory lock, and re-read the token
 * once they hold it.
 */
export async function refreshAccountToken(
  account: { id: string; workspaceId: string; platform: SocialPlatform; externalId: string },
  now = new Date(),
  opts: { unlessValidFor?: number } = {},
): Promise<RefreshOutcome> {
  const adapter = getAdapter(account.platform);
  const result = await prisma.$transaction(
    async (tx): Promise<{ outcome: RefreshOutcome; reason?: string }> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`oauth-refresh:${account.id}`}))`;
      const token = await tx.oAuthToken.findUnique({ where: { socialAccountId: account.id } });
      if (!token) return { outcome: "needs_reauth", reason: "The account has no stored token" };
      if (opts.unlessValidFor !== undefined && (!token.expiresAt || token.expiresAt.getTime() > now.getTime() + opts.unlessValidFor)) {
        return { outcome: "fresh" };
      }

      try {
        const refreshed = await adapter.refreshToken({
          accessToken: decryptToken(token.accessTokenEnc),
          refreshToken: token.refreshTokenEnc ? decryptToken(token.refreshTokenEnc) : undefined,
          expiresAt: token.expiresAt ?? undefined,
          scopes: token.scopes,
        }, account);
        await tx.oAuthToken.update({
          where: { socialAccountId: account.id },
          data: {
            accessTokenEnc: encryptToken(refreshed.accessToken),
            refreshTokenEnc: refreshed.refreshToken ? encryptToken(refreshed.refreshToken) : token.refreshTokenEnc,
            expiresAt: refreshed.expiresAt ?? null,
            lastRefreshedAt: now,
            failureCount: 0,
            lastError: null,
          },
        });
        return { outcome: "refreshed" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const tokenRejected = err instanceof PlatformApiError && err.code === "INVALID_TOKEN";
        const failures = token.failureCount + 1;
        if (tokenRejected || failures >= MAX_FAILURES) return { outcome: "needs_reauth", reason: message };
        await tx.oAuthToken.update({
          where: { socialAccountId: account.id },
          data: { failureCount: failures, lastError: message.slice(0, 500) },
        });
        return { outcome: "failed", reason: message };
      }
    },
    // The platform call happens inside the transaction (it must, to hold the lock); its own timeout is 60 s.
    { maxWait: 90_000, timeout: 90_000 },
  );

  if (result.outcome === "needs_reauth") await markNeedsReauth(account, result.reason ?? "Token refresh failed");
  return result.outcome;
}

/** The account can't be used until someone reconnects it. The UI and pre-flight warnings pick this up. */
export async function markNeedsReauth(account: { id: string; workspaceId: string }, reason: string, action = "social_account.token_refresh_failed") {
  await prisma.$transaction(async (tx) => {
    await tx.socialAccount.update({ where: { id: account.id }, data: { status: "NEEDS_REAUTH" } });
    await tx.oAuthToken.update({ where: { socialAccountId: account.id }, data: { lastError: reason.slice(0, 500) } });
    await audit(
      {
        action,
        workspaceId: account.workspaceId,
        targetType: "social_account",
        targetId: account.id,
        metadata: { reason: reason.slice(0, 500) },
      },
      tx,
    );
  });
}

/** Connect states are only valid for 10 minutes; drop old ones so the table stays small. */
export async function purgeExpiredConnectStates(now = new Date()): Promise<number> {
  const { count } = await prisma.oAuthConnectState.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - 86_400_000) } },
  });
  return count;
}
