"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { Alert } from "@/components/ui/Alert";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { ApiError } from "@/lib/api";
import {
  bestHour,
  formatCount,
  formatPercent,
  getBestTimes,
  getOverview,
  getTopPosts,
  gridToLocal,
  hourLabel,
  percentChange,
  topPostsCsv,
  WEEKDAYS_SUN_FIRST,
  type BestTimes,
  type Overview,
  type PostSort,
  type RangeDays,
  type TopPost,
} from "@/lib/analytics";
import { formatRelative, localTimeZone, useNow } from "@/lib/dates";
import { formatLabel } from "@/lib/instagramRules";
import { Heatmap } from "./Heatmap";
import { LineChart } from "./LineChart";

const RANGES: RangeDays[] = [7, 30, 90];
const SORTS: { value: PostSort; label: string }[] = [
  { value: "views", label: "Views" },
  { value: "reach", label: "Reach" },
  { value: "interactions", label: "Interactions" },
  { value: "engagement", label: "Engagement rate" },
  { value: "recent", label: "Newest" },
];

interface Loaded {
  key: string;
  overview: Overview;
  posts: TopPost[];
  bestTimes: BestTimes;
}

export function AnalyticsView() {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id;
  const [accountId, setAccountId] = useState<string | undefined>();
  const [days, setDays] = useState<RangeDays>(30);
  const [sort, setSort] = useState<PostSort>("views");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const now = useNow();

  const key = `${workspaceId}|${accountId ?? ""}|${days}|${sort}`;
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    Promise.all([
      getOverview(workspaceId, { accountId, days }),
      getTopPosts(workspaceId, { accountId, days, sort }),
      getBestTimes(workspaceId, accountId),
    ]).then(
      ([overview, top, bestTimes]) => active && setLoaded({ key, overview, posts: top.posts, bestTimes }),
      (err: unknown) => active && setError({ key, message: err instanceof ApiError ? err.message : "Couldn't load analytics." }),
    );
    return () => {
      active = false;
    };
  }, [workspaceId, accountId, days, sort, key]);

  const utcGrid = loaded?.bestTimes.grid ?? null;
  const localGrid = useMemo(() => (utcGrid ? gridToLocal(utcGrid) : null), [utcGrid]);

  if (error?.key === key) {
    return (
      <Page>
        <Alert tone="error">{error.message}</Alert>
      </Page>
    );
  }
  // Keep showing the previous data while a new range loads, so the page doesn't flash.
  if (!loaded) return <PageLoading />;
  const stale = loaded.key !== key;
  const { overview, posts } = loaded;

  if (!overview.account) {
    return (
      <Page>
        <Alert tone="info">
          Connect an Instagram account to see analytics.{" "}
          <Link href="/accounts" className="font-medium underline">
            Go to accounts
          </Link>
        </Alert>
      </Page>
    );
  }

  const account = overview.account;
  const t = overview.totals;
  const p = overview.previousTotals;
  const range = overview.range;

  function exportCsv() {
    const blob = new Blob([`﻿${topPostsCsv(posts)}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${account.username ?? "instagram"}-posts-${range.from}-to-${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Page>
      <div className="flex flex-wrap items-center gap-3">
        {overview.accounts.length > 1 ? (
          <label className="flex items-center gap-2 text-sm">
            <span className="sr-only">Account</span>
            <select
              value={account.id}
              onChange={(e) => setAccountId(e.target.value)}
              className="h-9 rounded-lg border border-neutral-300 bg-transparent px-2 text-sm dark:border-neutral-700"
            >
              {overview.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-sm font-medium">@{account.username}</p>
        )}
        <div role="group" aria-label="Date range" className="flex rounded-lg border border-neutral-300 p-0.5 text-sm dark:border-neutral-700">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={days === r}
              onClick={() => setDays(r)}
              className={`rounded-md px-3 py-1 ${days === r ? "bg-foreground text-background" : "hover:bg-neutral-100 dark:hover:bg-neutral-900"}`}
            >
              {r} days
            </button>
          ))}
        </div>
        <p className="text-xs text-neutral-500 sm:ml-auto">
          {overview.lastCollectedAt ? `Updated ${formatRelative(new Date(overview.lastCollectedAt), new Date(now))} · ` : ""}
          Instagram data can be up to 48 h behind
          {stale ? " · Loading…" : ""}
        </p>
      </div>

      {!account.insightsAllowed ? (
        <div className="mt-4">
          <Alert tone="info">
            Analytics need a new Instagram permission.{" "}
            <Link href="/accounts" className="font-medium underline">
              Reconnect @{account.username}
            </Link>{" "}
            and allow access to insights. Publishing keeps working either way.
          </Alert>
        </div>
      ) : overview.daysWithData === 0 && !overview.lastCollectedAt ? (
        <div className="mt-4">
          <Alert tone="info">Collecting numbers from Instagram. The first ones appear within about an hour while the worker is running.</Alert>
        </div>
      ) : null}

      {/* Summary */}
      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat
          label="Followers"
          value={formatCount(overview.followers.current)}
          change={overview.followers.change == null ? null : `${overview.followers.change >= 0 ? "+" : ""}${overview.followers.change.toLocaleString()} in ${days} days`}
          good={overview.followers.change == null ? null : overview.followers.change >= 0}
        />
        <Stat label="Reach" hint="Sum of daily accounts reached" value={formatCount(t.reach)} {...vsPrevious(t.reach, p.reach)} />
        <Stat label="Views" value={formatCount(t.views)} {...vsPrevious(t.views, p.views)} />
        <Stat label="Interactions" hint="Likes, comments, shares and saves" value={formatCount(t.totalInteractions)} {...vsPrevious(t.totalInteractions, p.totalInteractions)} />
        <Stat
          label="Engagement rate"
          hint="Interactions ÷ reach"
          value={formatPercent(t.engagementRate)}
          change={t.engagementRate != null && p.engagementRate != null ? `${t.engagementRate >= p.engagementRate ? "+" : ""}${((t.engagementRate - p.engagementRate) * 100).toFixed(1)} pts` : null}
          good={t.engagementRate != null && p.engagementRate != null ? t.engagementRate >= p.engagementRate : null}
        />
      </dl>

      <section className="mt-8 rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Daily reach and views</h2>
        {overview.series.every((d) => d.reach == null && d.views == null) ? (
          <p className="mt-3 text-sm text-neutral-500">No numbers for this period yet.</p>
        ) : (
          <div className="mt-3">
            <LineChart
              title={`Daily reach and views for @${account.username}, ${overview.range.from} to ${overview.range.to} (UTC days)`}
              labels={overview.series.map((s) => s.date)}
              series={[
                { label: "Reach", colorClass: "stroke-violet-600 fill-violet-600", values: overview.series.map((s) => s.reach) },
                { label: "Views", colorClass: "stroke-sky-500 fill-sky-500", values: overview.series.map((s) => s.views) },
              ]}
            />
          </div>
        )}
        <p className="mt-2 text-xs text-neutral-500">
          {t.follows != null ? `${t.follows} new followers, ${t.unfollows ?? 0} unfollows · ` : ""}
          {t.profileLinksTaps != null ? `${t.profileLinksTaps} link taps · ` : ""}Days are UTC days.
        </p>
      </section>

      {/* Top posts */}
      <section className="mt-8" aria-labelledby="top-posts">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="top-posts" className="text-sm font-medium">
            Posts from the last {days} days
          </h2>
          <label className="ml-auto flex items-center gap-2 text-xs text-neutral-500">
            Sort by
            <select value={sort} onChange={(e) => setSort(e.target.value as PostSort)} className="h-8 rounded-lg border border-neutral-300 bg-transparent px-2 text-xs dark:border-neutral-700">
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={exportCsv} disabled={posts.length === 0} className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-medium disabled:opacity-50 dark:border-neutral-700">
            Export CSV
          </button>
        </div>
        {posts.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No posts published from here in this period. Only posts published through AI Social have per-post numbers.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-left text-xs text-neutral-500">
                <tr className="border-b border-neutral-200 dark:border-neutral-800">
                  <th scope="col" className="p-3 font-normal">
                    Post
                  </th>
                  <th scope="col" className="p-3 text-right font-normal">
                    Views
                  </th>
                  <th scope="col" className="p-3 text-right font-normal">
                    Reach
                  </th>
                  <th scope="col" className="p-3 text-right font-normal">
                    Interactions
                  </th>
                  <th scope="col" className="p-3 text-right font-normal">
                    Engagement
                  </th>
                </tr>
              </thead>
              <tbody>
                {posts.map((post) => (
                  <tr key={post.targetId} className="border-b border-neutral-100 last:border-0 dark:border-neutral-900">
                    <td className="p-3">
                      <Link href={`/posts/${post.postId}`} className="flex items-center gap-3 hover:underline">
                        {post.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={post.thumbnailUrl} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" />
                        ) : (
                          <span className="h-10 w-10 shrink-0 rounded-md bg-neutral-100 dark:bg-neutral-900" />
                        )}
                        <span className="min-w-0">
                          <span className="line-clamp-1">{post.caption || "(no caption)"}</span>
                          <span className="block text-xs text-neutral-500">
                            {formatLabel[post.format]}
                            {post.publishedAt ? ` · ${new Date(post.publishedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""}
                            {post.metricsStatus === "PENDING" ? " · numbers coming soon" : post.metricsStatus === "UNAVAILABLE" ? " · no longer on Instagram" : ""}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="p-3 text-right tabular-nums">{formatCount(post.views)}</td>
                    <td className="p-3 text-right tabular-nums">{formatCount(post.reach)}</td>
                    <td className="p-3 text-right tabular-nums">{formatCount(post.totalInteractions)}</td>
                    <td className="p-3 text-right tabular-nums">{formatPercent(post.engagementRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Best time to post */}
      <section className="mt-8 rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800" aria-labelledby="best-times">
        <h2 id="best-times" className="text-sm font-medium">
          When your followers are online
        </h2>
        {localGrid ? (
          <>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              <BestSlot grid={localGrid} /> Times in {localTimeZone()}, averaged over the last 30 days.
            </p>
            <div className="mt-3">
              <Heatmap grid={localGrid} />
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-neutral-500">
            {account.insightsAllowed
              ? "Instagram shares this for accounts with at least 100 followers. It appears here once available."
              : "Available after reconnecting with the insights permission."}
          </p>
        )}
      </section>
    </Page>
  );
}

function vsPrevious(current: number | null, previous: number | null) {
  const change = percentChange(current, previous);
  return change == null ? { change: null, good: null } : { change: `${change >= 0 ? "+" : ""}${Math.round(change * 100)}% vs previous`, good: change >= 0 };
}

function Stat({ label, value, change, good, hint }: { label: string; value: string; change: string | null; good: boolean | null; hint?: string }) {
  return (
    <div className="rounded-2xl border border-neutral-200 p-3 dark:border-neutral-800">
      <dt className="text-xs text-neutral-500" title={hint}>
        {label}
      </dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
      <dd className={`text-xs ${good === null ? "text-neutral-500" : good ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>{change ?? "No earlier data"}</dd>
    </div>
  );
}

function BestSlot({ grid }: { grid: number[][] }) {
  let best = { day: 0, hour: 0, value: -1 };
  grid.forEach((row, day) => row.forEach((value, hour) => value > best.value && (best = { day, hour, value })));
  const everyDay = bestHour(grid);
  if (best.value <= 0 || everyDay === null) return null;
  return (
    <>
      Most active: <strong>{WEEKDAYS_SUN_FIRST[best.day]} around {hourLabel(best.hour)}</strong>; on a typical day, around <strong>{hourLabel(everyDay)}</strong>.
    </>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Analytics</h1>
      <div className="mt-6">{children}</div>
    </div>
  );
}
