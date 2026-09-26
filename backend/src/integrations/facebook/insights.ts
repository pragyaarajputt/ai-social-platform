import type { PostFormat } from "../../generated/prisma/enums.js";
import { firstRecord } from "../meta.js";
import type { AccountDayMetrics, InsightsContext, InsightsProvider, PostMetrics } from "../types.js";
import { graphGet, INSIGHTS_SCOPE, type FacebookAppConfig } from "./client.js";

// Facebook Page insights (checked 2026-09-26): https://developers.facebook.com/docs/graph-api/reference/insights
// Many Page metrics were deprecated on 15 June 2026 (page_impressions*, page_post_engagements,
// page_follows, page_daily_follows_unique, ...). Only the "media view" metrics that replace them are
// used here. Follows/unfollows and "when followers are online" are no longer available for Pages.

type Row = { name?: string; values?: { value?: unknown; end_time?: string }[] };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function metricValues(body: unknown): Map<string, number | undefined> {
  const rows = ((body as { data?: Row[] })?.data ?? []) as Row[];
  return new Map(rows.map((r) => [String(r.name), num(r.values?.[0]?.value)]));
}

/** post_reactions_by_type_total is an object like { like: 10, love: 2 }. */
function sumObject(v: unknown): number | undefined {
  if (!v || typeof v !== "object") return undefined;
  return Object.values(v as Record<string, unknown>).reduce<number>((sum, x) => sum + (num(x) ?? 0), 0);
}

export function facebookInsights(app: () => FacebookAppConfig): InsightsProvider {
  return {
    requiredScope: INSIGHTS_SCOPE,

    async postMetrics(ctx: InsightsContext, postId: string, _format: PostFormat): Promise<PostMetrics> {
      const insights = (await graphGet(app(), `${postId}/insights`, ctx.accessToken, {
        metric: "post_media_view,post_total_media_view_unique,post_reactions_by_type_total",
        period: "lifetime",
      })) as { data?: Row[] };
      const m = metricValues(insights);
      const reactionsRow = (insights.data ?? []).find((r) => r.name === "post_reactions_by_type_total");

      // Comments and shares come from the post itself.
      const post = firstRecord(
        await graphGet(app(), postId, ctx.accessToken, { fields: "shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)" }),
      );
      const comments = num((post.comments as { summary?: { total_count?: unknown } } | undefined)?.summary?.total_count);
      const shares = num((post.shares as { count?: unknown } | undefined)?.count) ?? (post.shares === undefined ? 0 : undefined);
      const reactions =
        sumObject(reactionsRow?.values?.[0]?.value) ?? num((post.reactions as { summary?: { total_count?: unknown } } | undefined)?.summary?.total_count);

      const parts = [reactions, comments, shares].filter((v): v is number => v !== undefined);
      return {
        views: m.get("post_media_view"),
        reach: m.get("post_total_media_view_unique"),
        likes: reactions,
        comments,
        shares,
        totalInteractions: parts.length ? parts.reduce((a, b) => a + b, 0) : undefined,
      };
    },

    async accountDay(ctx: InsightsContext, dayStart: Date): Promise<AccountDayMetrics> {
      const since = dayStart.getTime() / 1000;
      const m = metricValues(
        await graphGet(app(), `${ctx.accountExternalId}/insights`, ctx.accessToken, {
          metric: "page_media_view,page_total_media_view_unique",
          period: "day",
          since: String(since),
          until: String(since + 86_400),
        }),
      );
      return { views: m.get("page_media_view"), reach: m.get("page_total_media_view_unique") };
    },

    async followersCount(ctx: InsightsContext) {
      const page = firstRecord(await graphGet(app(), ctx.accountExternalId, ctx.accessToken, { fields: "followers_count" }));
      return num(page.followers_count);
    },

    // page_fans_online was deprecated; Facebook no longer says when a Page's followers are online.
    async onlineFollowers() {
      return null;
    },
  };
}
