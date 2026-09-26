import { prisma } from "../config/database.js";
import { Prisma, type SocialAccount } from "../generated/prisma/client.js";
import { getAdapter } from "../integrations/registry.js";
import { PlatformApiError, type InsightsContext, type InsightsProvider } from "../integrations/types.js";
import { audit } from "../services/audit.service.js";
import { decryptToken } from "../utils/tokenCrypto.js";

// Collects analytics from the platforms. Runs in the worker's hourly maintenance, under its lock.
//
// - Post numbers: on a decaying schedule after publishing (most change happens in the first days),
//   then weekly, stopping at 90 days.
// - Account numbers: one row per UTC day for the last 30 days. Recent days are fetched again until
//   they're 3 days old, because platforms report late (Instagram: up to 48 hours).
// - Follower count: sampled once per UTC day.
// - When followers are online: refreshed daily.
//
// Each account has a budget of API calls per run, so a backlog (e.g. the first 30-day backfill) is
// spread over several runs instead of hitting rate limits.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Offsets after publishing at which post numbers are collected. */
export const METRIC_OFFSETS_MS = [1 * HOUR, 6 * HOUR, 1 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 37 * DAY, 44 * DAY, 51 * DAY, 58 * DAY, 65 * DAY, 72 * DAY, 79 * DAY, 86 * DAY, 90 * DAY];
export const METRICS_WINDOW_MS = 90 * DAY;
export const BACKFILL_DAYS = 30;
/** A day's numbers are re-fetched until the day is this old. */
const SETTLE_MS = 3 * DAY;
/** How long before re-fetching a day that hasn't settled yet. */
const REFETCH_UNSETTLED_MS = 20 * HOUR;
const AUDIENCE_TTL_MS = 23 * HOUR;
const DEFAULT_CALLS_PER_ACCOUNT = 40;

/** The first scheduled collection time still in the future, or null when collection is done. */
export function nextFetchAt(publishedAt: Date, now: Date): Date | null {
  for (const offset of METRIC_OFFSETS_MS) {
    const at = new Date(publishedAt.getTime() + offset);
    if (at > now) return at;
  }
  return null;
}

export const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export interface AnalyticsSummary {
  accounts: number;
  posts: number;
  unavailable: number;
  days: number;
  followers: number;
  audiences: number;
  permissionLost: number;
  stopped: number;
}

/** Ends this account's collection for this run (rate limit, outage, bad token, lost permission). */
class StopAccount extends Error {}

export async function runAnalyticsCollection(now = new Date(), options: { callsPerAccount?: number } = {}): Promise<AnalyticsSummary> {
  const summary: AnalyticsSummary = { accounts: 0, posts: 0, unavailable: 0, days: 0, followers: 0, audiences: 0, permissionLost: 0, stopped: 0 };

  // Newly published targets get a metrics row, due at their first scheduled collection.
  await prisma.$executeRaw`
    INSERT INTO post_target_metrics (post_target_id, next_fetch_at)
    SELECT t.id, t.published_at + interval '1 hour'
    FROM post_targets t
    LEFT JOIN post_target_metrics m ON m.post_target_id = t.id
    WHERE t.status = 'PUBLISHED' AND t.external_post_id IS NOT NULL AND t.published_at IS NOT NULL
      AND t.published_at > ${new Date(now.getTime() - METRICS_WINDOW_MS)} AND m.post_target_id IS NULL`;

  const accounts = await prisma.socialAccount.findMany({
    where: { status: "ACTIVE", insightsAllowed: true, token: { isNot: null } },
    include: { token: true },
  });

  for (const account of accounts) {
    const insights = getAdapter(account.platform).insights;
    if (!insights || !account.token) continue;
    summary.accounts += 1;
    const ctx: InsightsContext = { accessToken: decryptToken(account.token.accessTokenEnc), accountExternalId: account.externalId };
    let budget = options.callsPerAccount ?? DEFAULT_CALLS_PER_ACCOUNT;

    /** Makes one platform call. Per-item problems come back as BAD_REQUEST; everything else stops the account. */
    const call = async <T>(fn: () => Promise<T>, cost = 1): Promise<{ ok: true; value: T } | { ok: false; error: PlatformApiError }> => {
      if (budget < cost) throw new StopAccount("budget");
      budget -= cost;
      try {
        return { ok: true, value: await fn() };
      } catch (err) {
        if (!(err instanceof PlatformApiError)) throw err;
        if (err.code === "PERMISSION_DENIED") {
          await revokeInsights(account, err.message);
          summary.permissionLost += 1;
          throw new StopAccount("permission");
        }
        if (err.code === "BAD_REQUEST" || err.code === "MEDIA_REJECTED") return { ok: false, error: err };
        throw new StopAccount(err.code);
      }
    };

    try {
      await collectPosts(account, insights, ctx, call, now, summary);
      await collectFollowers(account, insights, ctx, call, now, summary);
      await collectDays(account, insights, ctx, call, now, summary);
      await collectAudience(account, insights, ctx, call, now, summary);
    } catch (err) {
      if (!(err instanceof StopAccount)) throw err;
      if (err.message !== "budget") summary.stopped += 1;
    }
  }
  return summary;
}

type Call = <T>(fn: () => Promise<T>, cost?: number) => Promise<{ ok: true; value: T } | { ok: false; error: PlatformApiError }>;

async function collectPosts(account: SocialAccount, insights: InsightsProvider, ctx: InsightsContext, call: Call, now: Date, summary: AnalyticsSummary) {
  const due = await prisma.postTargetMetrics.findMany({
    where: { nextFetchAt: { lte: now }, status: { not: "UNAVAILABLE" }, postTarget: { socialAccountId: account.id, status: "PUBLISHED" } },
    include: { postTarget: { select: { externalPostId: true, format: true, publishedAt: true } } },
    orderBy: { nextFetchAt: "asc" },
    take: 50,
  });
  for (const m of due) {
    const { externalPostId, format, publishedAt } = m.postTarget;
    const result = await call(() => insights.postMetrics(ctx, externalPostId!, format));
    if (!result.ok) {
      await prisma.postTargetMetrics.update({
        where: { postTargetId: m.postTargetId },
        data: { status: "UNAVAILABLE", nextFetchAt: null, lastError: result.error.message.slice(0, 500) },
      });
      summary.unavailable += 1;
      continue;
    }
    const v = result.value;
    const values = {
      views: v.views ?? null,
      reach: v.reach ?? null,
      likes: v.likes ?? null,
      comments: v.comments ?? null,
      shares: v.shares ?? null,
      saves: v.saves ?? null,
      totalInteractions: v.totalInteractions ?? null,
      profileVisits: v.profileVisits ?? null,
      follows: v.follows ?? null,
      avgWatchTimeMs: v.avgWatchTimeMs ?? null,
    };
    await prisma.$transaction([
      prisma.postTargetMetrics.update({
        where: { postTargetId: m.postTargetId },
        data: { ...values, status: "OK", fetchedAt: now, fetchCount: { increment: 1 }, nextFetchAt: nextFetchAt(publishedAt!, now), lastError: null },
      }),
      prisma.postMetricSnapshot.create({
        data: { postTargetId: m.postTargetId, capturedAt: now, views: values.views, reach: values.reach, totalInteractions: values.totalInteractions },
      }),
    ]);
    summary.posts += 1;
  }
}

async function collectFollowers(account: SocialAccount, insights: InsightsProvider, ctx: InsightsContext, call: Call, now: Date, summary: AnalyticsSummary) {
  const date = utcDay(now);
  const today = await prisma.accountDailyStats.findUnique({ where: { socialAccountId_date: { socialAccountId: account.id, date } } });
  if (today?.followers != null) return;
  const result = await call(() => insights.followersCount(ctx));
  if (!result.ok || result.value === undefined) return;
  await prisma.accountDailyStats.upsert({
    where: { socialAccountId_date: { socialAccountId: account.id, date } },
    create: { socialAccountId: account.id, date, followers: result.value },
    update: { followers: result.value },
  });
  summary.followers += 1;
}

async function collectDays(account: SocialAccount, insights: InsightsProvider, ctx: InsightsContext, call: Call, now: Date, summary: AnalyticsSummary) {
  const today = utcDay(now);
  const from = new Date(today.getTime() - BACKFILL_DAYS * DAY);
  const existing = await prisma.accountDailyStats.findMany({
    where: { socialAccountId: account.id, date: { gte: from, lt: today } },
    select: { date: true, insightsFetchedAt: true },
  });
  const fetchedAt = new Map(existing.map((r) => [r.date.getTime(), r.insightsFetchedAt]));

  // Most recent first, so a new account's dashboard fills in from today backwards.
  for (let t = today.getTime() - DAY; t >= from.getTime(); t -= DAY) {
    const last = fetchedAt.get(t) ?? null;
    const settled = last !== null && last.getTime() >= t + SETTLE_MS;
    const recentlyFetched = last !== null && now.getTime() - last.getTime() < REFETCH_UNSETTLED_MS;
    if (settled || recentlyFetched) continue;

    const date = new Date(t);
    const result = await call(() => insights.accountDay(ctx, date), 2);
    // A day the platform can't report (e.g. before the account existed) is recorded as empty.
    const v = result.ok ? result.value : {};
    const data = {
      reach: v.reach ?? null,
      views: v.views ?? null,
      accountsEngaged: v.accountsEngaged ?? null,
      totalInteractions: v.totalInteractions ?? null,
      likes: v.likes ?? null,
      comments: v.comments ?? null,
      shares: v.shares ?? null,
      saves: v.saves ?? null,
      profileLinksTaps: v.profileLinksTaps ?? null,
      follows: v.follows ?? null,
      unfollows: v.unfollows ?? null,
      insightsFetchedAt: now,
    };
    await prisma.accountDailyStats.upsert({
      where: { socialAccountId_date: { socialAccountId: account.id, date } },
      create: { socialAccountId: account.id, date, ...data },
      update: data,
    });
    summary.days += 1;
  }
}

async function collectAudience(account: SocialAccount, insights: InsightsProvider, ctx: InsightsContext, call: Call, now: Date, summary: AnalyticsSummary) {
  if (account.audienceFetchedAt && now.getTime() - account.audienceFetchedAt.getTime() < AUDIENCE_TTL_MS) return;
  const result = await call(() => insights.onlineFollowers(ctx));
  const grid = result.ok ? result.value : null;
  await prisma.$transaction([
    prisma.accountAudience.upsert({
      where: { socialAccountId: account.id },
      create: { socialAccountId: account.id, onlineGrid: grid ?? undefined, fetchedAt: now },
      update: { onlineGrid: grid ?? Prisma.DbNull, fetchedAt: now },
    }),
    prisma.socialAccount.update({ where: { id: account.id }, data: { audienceFetchedAt: now } }),
  ]);
  summary.audiences += 1;
}

async function revokeInsights(account: SocialAccount, reason: string) {
  await prisma.socialAccount.update({ where: { id: account.id }, data: { insightsAllowed: false } });
  await audit({
    action: "social_account.insights_denied",
    workspaceId: account.workspaceId,
    targetType: "social_account",
    targetId: account.id,
    metadata: { reason: reason.slice(0, 300) },
  });
}
