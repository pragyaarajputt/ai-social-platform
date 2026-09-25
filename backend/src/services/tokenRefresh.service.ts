import { prisma } from "../config/database.js";
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
    include: { socialAccount: { select: { id: true, workspaceId: true, platform: true } } },
  });

  const summary: RefreshSummary = { checked: due.length, refreshed: 0, skipped: 0, failed: 0, needsReauth: 0 };

  for (const token of due) {
    const account = token.socialAccount;
    const adapter = getAdapter(account.platform);

    if (token.expiresAt && token.expiresAt <= now) {
      await markNeedsReauth(account, "Token expired before it could be refreshed");
      summary.needsReauth++;
      continue;
    }
    const notBefore = adapter.refreshableAfter?.(token.lastRefreshedAt ?? token.createdAt);
    if (notBefore && notBefore > now) {
      summary.skipped++;
      continue;
    }

    try {
      const refreshed = await adapter.refreshToken({
        accessToken: decryptToken(token.accessTokenEnc),
        refreshToken: token.refreshTokenEnc ? decryptToken(token.refreshTokenEnc) : undefined,
        expiresAt: token.expiresAt ?? undefined,
        scopes: token.scopes,
      });
      await prisma.oAuthToken.update({
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
      summary.refreshed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const tokenRejected = err instanceof PlatformApiError && err.code === "INVALID_TOKEN";
      const failures = token.failureCount + 1;

      if (tokenRejected || failures >= MAX_FAILURES) {
        await markNeedsReauth(account, message);
        summary.needsReauth++;
      } else {
        await prisma.oAuthToken.update({
          where: { socialAccountId: account.id },
          data: { failureCount: failures, lastError: message.slice(0, 500) },
        });
        summary.failed++;
      }
    }
  }
  return summary;
}

async function markNeedsReauth(account: { id: string; workspaceId: string }, reason: string) {
  await prisma.$transaction(async (tx) => {
    await tx.socialAccount.update({ where: { id: account.id }, data: { status: "NEEDS_REAUTH" } });
    await tx.oAuthToken.update({ where: { socialAccountId: account.id }, data: { lastError: reason.slice(0, 500) } });
    await audit(
      {
        action: "social_account.token_refresh_failed",
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
