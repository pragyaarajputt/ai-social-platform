import type { PostFormat } from "../../generated/prisma/enums.js";
import type { AccountDayMetrics, InsightsContext, InsightsProvider, PostMetrics } from "../types.js";
import { graphGet, INSIGHTS_SCOPE, type InstagramAppConfig } from "./client.js";

// Instagram insights (checked 2026-09-25):
// https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights
// https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights
// `impressions` no longer exists (removed for new media in 2024 and everywhere in April 2025); `views`
// replaces it. Numbers can be up to 48 hours late. Asking for a metric a media type doesn't support
// fails the whole call, so each format has its own list.

const FEED_METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "profile_visits", "follows"];
const REELS_METRICS = ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time"];
const ACCOUNT_METRICS = ["reach", "views", "accounts_engaged", "total_interactions", "likes", "comments", "shares", "saves", "profile_links_taps"];

type InsightRow = { name?: string; values?: { value?: unknown; end_time?: string }[]; total_value?: { value?: unknown; breakdowns?: Breakdown[] } };
type Breakdown = { results?: { dimension_values?: string[]; value?: unknown }[] };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A metric's value from either response shape: `values[0].value` (media) or `total_value.value` (account). */
function valueOf(row: InsightRow): number | undefined {
  return num(row.total_value?.value) ?? num(row.values?.[0]?.value);
}

function rows(body: unknown): InsightRow[] {
  const data = (body as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as InsightRow[]) : [];
}

function byName(body: unknown): Map<string, InsightRow> {
  return new Map(rows(body).map((r) => [String(r.name), r]));
}

export function instagramInsights(app: () => InstagramAppConfig): InsightsProvider {
  return {
    requiredScope: INSIGHTS_SCOPE,

    async postMetrics(ctx: InsightsContext, mediaId: string, format: PostFormat): Promise<PostMetrics> {
      const metrics = format === "REEL" ? REELS_METRICS : FEED_METRICS;
      const m = byName(await graphGet(app(), `${mediaId}/insights`, ctx.accessToken, { metric: metrics.join(","), period: "lifetime" }));
      const get = (name: string) => (m.has(name) ? valueOf(m.get(name)!) : undefined);
      return {
        views: get("views"),
        reach: get("reach"),
        likes: get("likes"),
        comments: get("comments"),
        shares: get("shares"),
        saves: get("saved"),
        totalInteractions: get("total_interactions"),
        profileVisits: get("profile_visits"),
        follows: get("follows"),
        avgWatchTimeMs: get("ig_reels_avg_watch_time"),
      };
    },

    async accountDay(ctx: InsightsContext, dayStart: Date): Promise<AccountDayMetrics> {
      const range = { period: "day", metric_type: "total_value", since: String(dayStart.getTime() / 1000), until: String(dayStart.getTime() / 1000 + 86_400) };
      const path = `${ctx.accountExternalId}/insights`;
      const main = byName(await graphGet(app(), path, ctx.accessToken, { ...range, metric: ACCOUNT_METRICS.join(",") }));
      const get = (name: string) => (main.has(name) ? valueOf(main.get(name)!) : undefined);

      // Follows and unfollows come as one metric split by follow_type: FOLLOWER = new follows,
      // NON_FOLLOWER = unfollows.
      const fu = byName(await graphGet(app(), path, ctx.accessToken, { ...range, metric: "follows_and_unfollows", breakdown: "follow_type" }));
      const results = fu.get("follows_and_unfollows")?.total_value?.breakdowns?.[0]?.results ?? [];
      const split = (key: string) => num(results.find((r) => r.dimension_values?.[0] === key)?.value);

      return {
        reach: get("reach"),
        views: get("views"),
        accountsEngaged: get("accounts_engaged"),
        totalInteractions: get("total_interactions"),
        likes: get("likes"),
        comments: get("comments"),
        shares: get("shares"),
        saves: get("saves"),
        profileLinksTaps: get("profile_links_taps"),
        follows: split("FOLLOWER") ?? (results.length ? 0 : undefined),
        unfollows: split("NON_FOLLOWER") ?? (results.length ? 0 : undefined),
      };
    },

    async followersCount(ctx: InsightsContext) {
      const body = (await graphGet(app(), ctx.accountExternalId, ctx.accessToken, { fields: "followers_count" })) as Record<string, unknown>;
      return num(body.followers_count);
    },

    /**
     * `online_followers`: for each of the last 30 days, followers online per hour. Only for accounts
     * with 100+ followers; otherwise the values are empty. Each day's `end_time` marks the end of
     * that day, and hour keys count from its start, so each value maps to an exact UTC hour. The
     * result is averaged per UTC weekday × hour.
     */
    async onlineFollowers(ctx: InsightsContext) {
      const now = Math.floor(Date.now() / 1000);
      const body = await graphGet(app(), `${ctx.accountExternalId}/insights`, ctx.accessToken, {
        metric: "online_followers",
        period: "lifetime",
        since: String(now - 29 * 86_400),
        until: String(now),
      });
      return onlineGrid(rows(body)[0]?.values ?? []);
    },
  };
}

/** Averages hourly counts into a UTC weekday (0 = Sunday) × hour grid. Null if there's nothing. */
export function onlineGrid(days: { value?: unknown; end_time?: string }[]): number[][] | null {
  const sums = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const counts = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let any = false;
  for (const day of days) {
    const end = day.end_time ? Date.parse(day.end_time.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : NaN;
    if (!Number.isFinite(end) || !day.value || typeof day.value !== "object") continue;
    for (const [hourKey, raw] of Object.entries(day.value as Record<string, unknown>)) {
      const value = num(raw);
      const hour = Number(hourKey);
      if (value === undefined || !Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      const at = new Date(end - 86_400_000 + hour * 3_600_000);
      sums[at.getUTCDay()]![at.getUTCHours()]! += value;
      counts[at.getUTCDay()]![at.getUTCHours()]! += 1;
      any = true;
    }
  }
  if (!any) return null;
  return sums.map((row, d) => row.map((sum, h) => (counts[d]![h]! ? Math.round(sum / counts[d]![h]!) : 0)));
}
