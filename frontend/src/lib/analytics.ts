import { api } from "./api";
import type { PostFormat } from "./platforms";
import type { SocialAccount } from "./workspaces";

// Analytics: read from our own server (which collects from Instagram hourly), never from Instagram
// directly. Days are UTC calendar days.

export type RangeDays = 7 | 30 | 90;
export type PostSort = "views" | "reach" | "interactions" | "engagement" | "recent";

export interface DayTotals {
  reach: number | null;
  views: number | null;
  accountsEngaged: number | null;
  totalInteractions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  profileLinksTaps: number | null;
  follows: number | null;
  unfollows: number | null;
  engagementRate: number | null;
}

export type AnalyticsAccount = Pick<SocialAccount, "id" | "platform" | "username" | "name" | "avatarUrl" | "status"> & {
  insightsAllowed: boolean;
  audienceFetchedAt: string | null;
};

export interface SeriesPoint {
  date: string;
  reach: number | null;
  views: number | null;
  totalInteractions: number | null;
  followers: number | null;
}

export type Overview =
  | { accounts: AnalyticsAccount[]; account: null }
  | {
      accounts: AnalyticsAccount[];
      account: AnalyticsAccount;
      range: { days: RangeDays; from: string; to: string };
      totals: DayTotals;
      previousTotals: DayTotals;
      followers: { current: number | null; change: number | null };
      series: SeriesPoint[];
      daysWithData: number;
      lastCollectedAt: string | null;
    };

export interface TopPost {
  postId: string;
  targetId: string;
  caption: string;
  format: PostFormat;
  permalink: string | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  metricsStatus: "PENDING" | "OK" | "UNAVAILABLE";
  fetchedAt: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  totalInteractions: number | null;
  avgWatchTimeMs: number | null;
  engagementRate: number | null;
}

export interface BestTimes {
  account: { id: string; platform: SocialAccount["platform"]; username: string | null; insightsAllowed: boolean } | null;
  /** Average followers online per UTC weekday (0 = Sunday) × UTC hour. */
  grid: number[][] | null;
  fetchedAt: string | null;
}

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined).map(([k, v]) => [k, String(v)])).toString();

export function getOverview(workspaceId: string, params: { accountId?: string; days: RangeDays }) {
  return api<Overview>(`/workspaces/${workspaceId}/analytics/overview?${qs(params)}`);
}

export function getTopPosts(workspaceId: string, params: { accountId?: string; days: RangeDays; sort: PostSort }) {
  return api<{ posts: TopPost[] }>(`/workspaces/${workspaceId}/analytics/posts?${qs(params)}`);
}

export function getBestTimes(workspaceId: string, accountId?: string) {
  return api<BestTimes>(`/workspaces/${workspaceId}/analytics/best-times?${qs({ accountId })}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Interactions per account reached (0.042 = 4.2%), as the server computes it. */
export function engagementRate(interactions: number | null | undefined, reach: number | null | undefined): number | null {
  return interactions == null || !reach ? null : interactions / reach;
}

/** Change from `previous` to `current` as a fraction (0.25 = +25%); null when it can't be compared. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return (current - previous) / previous;
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export const formatCount = (n: number | null | undefined) => (n == null ? "—" : compact.format(n));
export const formatPercent = (f: number | null | undefined, digits = 1) => (f == null ? "—" : `${(f * 100).toFixed(digits)}%`);

/** Where a UTC weekday × hour falls locally. Injected in tests; the browser's zone by default. */
export type ToLocal = (utc: Date) => { day: number; hour: number };
const browserLocal: ToLocal = (d) => ({ day: d.getDay(), hour: d.getHours() });

// A Sunday, used to turn "UTC weekday + hour" into a real instant.
const REFERENCE_SUNDAY_UTC = Date.UTC(2026, 8, 20);

/**
 * Moves a UTC weekday × hour grid into local time: the value for Sunday 02:00 UTC is Saturday
 * 19:00 in California. Hours in a daylight-saving shift use the offset of the reference week.
 */
export function gridToLocal(utcGrid: number[][], toLocal: ToLocal = browserLocal): number[][] {
  const local = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const { day, hour } = toLocal(new Date(REFERENCE_SUNDAY_UTC + (d * 24 + h) * 3_600_000));
      local[day]![hour] = utcGrid[d]?.[h] ?? 0;
    }
  }
  return local;
}

/** The hour of the day with the most followers online (on `day`, or summed over the week). */
export function bestHour(localGrid: number[][], day?: number): number | null {
  const totals = new Array<number>(24).fill(0);
  for (const [d, row] of localGrid.entries()) {
    if (day !== undefined && d !== day) continue;
    row.forEach((v, h) => (totals[h]! += v));
  }
  const max = Math.max(...totals);
  return max > 0 ? totals.indexOf(max) : null;
}

export const WEEKDAYS_SUN_FIRST = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "7 PM" in the user's locale. */
export function hourLabel(hour: number): string {
  return new Date(2026, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}

/** CSV text (RFC 4180): fields with commas, quotes or line breaks are quoted. Formula-like cells are defused. */
export function toCsv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v == null) return "";
    let s = String(v);
    // Spreadsheets run cells starting with = + - @ as formulas; a caption shouldn't be able to.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n");
}

export function topPostsCsv(posts: TopPost[]): string {
  return toCsv([
    ["Published", "Caption", "Format", "Views", "Reach", "Likes", "Comments", "Shares", "Saves", "Interactions", "Engagement rate", "Link"],
    ...posts.map((p) => [
      p.publishedAt,
      p.caption,
      p.format,
      p.views,
      p.reach,
      p.likes,
      p.comments,
      p.shares,
      p.saves,
      p.totalInteractions,
      p.engagementRate == null ? null : Number((p.engagementRate * 100).toFixed(2)),
      p.permalink,
    ]),
  ]);
}
