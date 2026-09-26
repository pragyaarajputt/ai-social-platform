import { prisma } from "../config/database.js";
import type { AccountDailyStats } from "../generated/prisma/client.js";
import { utcDay } from "../jobs/analytics.js";
import type { AnalyticsQuery, TopPostsQuery } from "../schemas/analytics.schemas.js";
import { thumbnailUrl } from "../storage/cloudinary.js";
import { AppError } from "../utils/AppError.js";

// Read side of analytics: everything here comes from our own tables (filled by jobs/analytics.ts),
// so pages load fast and never wait on the platform. Days are UTC calendar days; a range of N days
// ends with yesterday, because today's numbers aren't complete yet.

const DAY = 86_400_000;

const DAY_METRICS = ["reach", "views", "accountsEngaged", "totalInteractions", "likes", "comments", "shares", "saves", "profileLinksTaps", "follows", "unfollows"] as const;
type DayMetric = (typeof DAY_METRICS)[number];

/** Interactions per account reached, as a fraction (0.042 = 4.2%). Null when nothing was reached. */
export function engagementRate(interactions: number | null | undefined, reach: number | null | undefined): number | null {
  if (interactions == null || !reach) return null;
  return interactions / reach;
}

/** Sum of a metric over rows; null if no row has it (so "no data" isn't shown as 0). */
function total(rows: AccountDailyStats[], key: DayMetric): number | null {
  let sum: number | null = null;
  for (const r of rows) if (r[key] != null) sum = (sum ?? 0) + r[key]!;
  return sum;
}

async function workspaceAccounts(workspaceId: string) {
  return prisma.socialAccount.findMany({
    where: { workspaceId, status: { not: "DISCONNECTED" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, platform: true, username: true, name: true, avatarUrl: true, status: true, insightsAllowed: true, audienceFetchedAt: true },
  });
}

/** The account asked for (must be in the workspace), or the workspace's first one. */
async function pickAccount(workspaceId: string, accountId?: string) {
  const accounts = await workspaceAccounts(workspaceId);
  const account = accountId ? accounts.find((a) => a.id === accountId) : (accounts.find((a) => a.status === "ACTIVE") ?? accounts[0]);
  if (accountId && !account) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
  return { accounts, account: account ?? null };
}

export async function getOverview(workspaceId: string, query: AnalyticsQuery, now = new Date()) {
  const { accounts, account } = await pickAccount(workspaceId, query.accountId);
  if (!account) return { accounts, account: null };

  const end = utcDay(now);
  const start = new Date(end.getTime() - query.days * DAY);
  const previousStart = new Date(start.getTime() - query.days * DAY);

  const rows = await prisma.accountDailyStats.findMany({
    where: { socialAccountId: account.id, date: { gte: previousStart, lte: end } },
    orderBy: { date: "asc" },
  });
  const current = rows.filter((r) => r.date >= start && r.date < end);
  const previous = rows.filter((r) => r.date < start);

  const totals = (set: AccountDailyStats[]) => {
    const t = Object.fromEntries(DAY_METRICS.map((k) => [k, total(set, k)])) as Record<DayMetric, number | null>;
    return { ...t, engagementRate: engagementRate(t.totalInteractions, t.reach) };
  };

  // Followers: latest sample (today's counts), compared with the last sample before the range.
  const latestFollowers = [...rows].reverse().find((r) => r.followers != null) ?? null;
  const before = await prisma.accountDailyStats.findFirst({
    where: { socialAccountId: account.id, date: { lte: start }, followers: { not: null } },
    orderBy: { date: "desc" },
  });

  const byDate = new Map(current.map((r) => [r.date.getTime(), r]));
  const series = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY) {
    const r = byDate.get(t);
    series.push({
      date: new Date(t).toISOString().slice(0, 10),
      reach: r?.reach ?? null,
      views: r?.views ?? null,
      totalInteractions: r?.totalInteractions ?? null,
      followers: r?.followers ?? null,
    });
  }

  const fetched = rows.map((r) => r.insightsFetchedAt).filter((d): d is Date => d !== null);
  return {
    accounts,
    account,
    range: { days: query.days, from: start.toISOString().slice(0, 10), to: new Date(end.getTime() - DAY).toISOString().slice(0, 10) },
    totals: totals(current),
    previousTotals: totals(previous),
    followers: {
      current: latestFollowers?.followers ?? null,
      change: latestFollowers?.followers != null && before?.followers != null && before.date < latestFollowers.date ? latestFollowers.followers - before.followers : null,
    },
    series,
    daysWithData: current.filter((r) => r.insightsFetchedAt !== null).length,
    lastCollectedAt: fetched.length ? new Date(Math.max(...fetched.map((d) => d.getTime()))) : null,
  };
}

const SORTS = {
  views: "views",
  reach: "reach",
  interactions: "totalInteractions",
  engagement: "engagementRate",
  recent: "publishedAt",
} as const;

export async function getTopPosts(workspaceId: string, query: TopPostsQuery, now = new Date()) {
  const { account } = await pickAccount(workspaceId, query.accountId);
  if (!account) return { posts: [] };

  const targets = await prisma.postTarget.findMany({
    where: { socialAccountId: account.id, status: "PUBLISHED", publishedAt: { gte: new Date(now.getTime() - query.days * DAY) }, post: { workspaceId } },
    include: {
      metrics: true,
      post: { select: { id: true, caption: true, media: { orderBy: { position: "asc" }, take: 1, include: { mediaAsset: true } } } },
    },
    orderBy: { publishedAt: "desc" },
    take: 500,
  });

  const posts = targets.map((t) => {
    const m = t.metrics;
    const cover = t.post.media[0]?.mediaAsset;
    return {
      postId: t.post.id,
      targetId: t.id,
      caption: t.post.caption,
      format: t.format,
      permalink: t.permalink,
      publishedAt: t.publishedAt,
      thumbnailUrl: cover ? thumbnailUrl(cover) : null,
      metricsStatus: m?.status ?? "PENDING",
      fetchedAt: m?.fetchedAt ?? null,
      views: m?.views ?? null,
      reach: m?.reach ?? null,
      likes: m?.likes ?? null,
      comments: m?.comments ?? null,
      shares: m?.shares ?? null,
      saves: m?.saves ?? null,
      totalInteractions: m?.totalInteractions ?? null,
      avgWatchTimeMs: m?.avgWatchTimeMs ?? null,
      engagementRate: engagementRate(m?.totalInteractions, m?.reach),
    };
  });

  const key = SORTS[query.sort];
  const value = (p: (typeof posts)[number]) => (key === "publishedAt" ? (p.publishedAt?.getTime() ?? null) : p[key]);
  // Highest first; posts without the number go last.
  posts.sort((a, b) => (value(b) ?? -Infinity) - (value(a) ?? -Infinity));
  return { posts: posts.slice(0, 100) };
}

export async function getBestTimes(workspaceId: string, accountId?: string) {
  const { account } = await pickAccount(workspaceId, accountId);
  if (!account) return { account: null, grid: null, fetchedAt: null };
  const audience = await prisma.accountAudience.findUnique({ where: { socialAccountId: account.id } });
  return {
    account: { id: account.id, platform: account.platform, username: account.username, insightsAllowed: account.insightsAllowed },
    /** Average followers online per UTC weekday (0 = Sunday) × UTC hour. */
    grid: (audience?.onlineGrid as number[][] | null | undefined) ?? null,
    fetchedAt: audience?.fetchedAt ?? null,
  };
}
