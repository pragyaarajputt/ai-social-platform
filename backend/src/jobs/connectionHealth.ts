import { prisma } from "../config/database.js";
import { getAdapter } from "../integrations/registry.js";
import { PlatformApiError } from "../integrations/types.js";
import { markNeedsReauth } from "../services/tokenRefresh.service.js";
import { decryptToken } from "../utils/tokenCrypto.js";

// Checks once a day that each connected account's token still works. Tokens that never expire
// (Facebook Pages) can still be revoked, by removing the app, losing the Page role or changing the
// password, and would otherwise only be noticed when a scheduled post fails. A broken account
// becomes NEEDS_REAUTH, which the UI shows and the pre-flight check emails about before posts are due.
// The same call refreshes the account's name and picture.

export const CHECK_EVERY_MS = 24 * 3_600_000;
const MAX_PER_RUN = 200;

export interface HealthSummary {
  checked: number;
  ok: number;
  needsReauth: number;
  /** Platform busy or unreachable: tried again next run; never counted against the account. */
  skipped: number;
}

export async function runConnectionHealthChecks(now = new Date()): Promise<HealthSummary> {
  const due = await prisma.socialAccount.findMany({
    where: {
      status: "ACTIVE",
      token: { isNot: null },
      OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now.getTime() - CHECK_EVERY_MS) } }],
    },
    include: { token: true },
    // Longest unchecked first, so a backlog is worked through fairly across runs.
    orderBy: { lastCheckedAt: { sort: "asc", nulls: "first" } },
    take: MAX_PER_RUN,
  });

  const summary: HealthSummary = { checked: 0, ok: 0, needsReauth: 0, skipped: 0 };
  for (const account of due) {
    const adapter = getAdapter(account.platform);
    if (!adapter.checkAccount || !adapter.isConfigured() || !account.token) continue;
    summary.checked += 1;
    try {
      const profile = await adapter.checkAccount({ accessToken: decryptToken(account.token.accessTokenEnc), accountExternalId: account.externalId });
      await prisma.socialAccount.update({
        where: { id: account.id },
        data: {
          lastCheckedAt: now,
          ...(profile.username !== undefined && { username: profile.username }),
          ...(profile.name !== undefined && { name: profile.name }),
          ...(profile.avatarUrl !== undefined && { avatarUrl: profile.avatarUrl }),
        },
      });
      summary.ok += 1;
    } catch (err) {
      if (!(err instanceof PlatformApiError)) {
        // A bug or database blip: log it, and don't let one account stop the rest of maintenance.
        console.error(`[health] checking account ${account.id} failed:`, err);
        summary.skipped += 1;
        continue;
      }
      // The token was rejected, or the permission / Page role behind it is gone: a person must reconnect.
      if (err.code === "INVALID_TOKEN" || err.code === "PERMISSION_DENIED") {
        await markNeedsReauth(account, err.message, "social_account.health_check_failed");
        await prisma.socialAccount.update({ where: { id: account.id }, data: { lastCheckedAt: now } });
        summary.needsReauth += 1;
      } else {
        // Rate limits, outages, odd answers: not evidence that the account is broken.
        summary.skipped += 1;
      }
    }
  }
  return summary;
}
