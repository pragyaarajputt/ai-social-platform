"use client";

import { IfCanEdit } from "@/components/workspace/IfCanEdit";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { PostStatusBadge } from "@/components/posts/PostStatusBadge";
import { Alert } from "@/components/ui/Alert";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { ApiError } from "@/lib/api";
import { addLocalDays, dayKey, formatDateTime, formatTime, localTimeZone, monthGrid, startOfLocalDay, WEEKDAY_LABELS } from "@/lib/dates";
import { listPosts, postDate, type Post, type PostStatus } from "@/lib/posts";

const chipTone: Partial<Record<PostStatus, string>> = {
  SCHEDULED: "bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200",
  PUBLISHING: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  PUBLISHED: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  PARTIALLY_FAILED: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  FAILED: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  CANCELLED: "bg-neutral-100 text-neutral-500 line-through dark:bg-neutral-900",
};

const AGENDA_DAYS = 14;

export function CalendarView() {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id;
  const today = startOfLocalDay(new Date());
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const weeks = useMemo(() => monthGrid(cursor.year, cursor.month), [cursor]);
  const [monthPosts, setMonthPosts] = useState<{ key: string; posts: Post[] } | null>(null);
  const [agenda, setAgenda] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const monthKey = `${cursor.year}-${cursor.month}`;

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    const from = weeks[0]![0]!;
    const to = addLocalDays(weeks.at(-1)![6]!, 1);
    listPosts(workspaceId, { from, to }).then(
      (posts) => active && setMonthPosts({ key: monthKey, posts }),
      (err: unknown) => active && setError(err instanceof ApiError ? err.message : "Couldn't load the calendar."),
    );
    return () => {
      active = false;
    };
  }, [workspaceId, weeks, monthKey]);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    const now = new Date();
    listPosts(workspaceId, { from: now, to: addLocalDays(startOfLocalDay(now), AGENDA_DAYS), status: ["SCHEDULED"] }).then(
      (posts) => active && setAgenda(posts),
      () => active && setAgenda([]),
    );
    return () => {
      active = false;
    };
  }, [workspaceId]);

  const byDay = useMemo(() => {
    const map = new Map<string, Post[]>();
    for (const p of monthPosts?.key === monthKey ? monthPosts.posts : []) {
      const key = dayKey(postDate(p));
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => postDate(a).getTime() - postDate(b).getTime());
    return map;
  }, [monthPosts, monthKey]);

  if (error) return <Wrapper><Alert tone="error">{error}</Alert></Wrapper>;
  if (!workspaceId || monthPosts?.key !== monthKey) return <PageLoading />;

  const monthLabel = new Date(cursor.year, cursor.month, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
  const move = (by: number) => setCursor((c) => ({ year: new Date(c.year, c.month + by, 1).getFullYear(), month: new Date(c.year, c.month + by, 1).getMonth() }));

  return (
    <Wrapper>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => move(-1)} aria-label="Previous month" className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
            ←
          </button>
          <h2 className="min-w-44 text-center text-lg font-medium">{monthLabel}</h2>
          <button type="button" onClick={() => move(1)} aria-label="Next month" className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
            →
          </button>
          <button
            type="button"
            onClick={() => setCursor({ year: today.getFullYear(), month: today.getMonth() })}
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:underline"
          >
            Today
          </button>
        </div>
        <p className="text-xs text-neutral-500">Times in {localTimeZone()}</p>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[42rem] table-fixed border-collapse text-sm">
          <thead>
            <tr>
              {WEEKDAY_LABELS.map((d) => (
                <th key={d} scope="col" className="pb-2 text-left text-xs font-medium text-neutral-500">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week) => (
              <tr key={dayKey(week[0]!)}>
                {week.map((day) => {
                  const key = dayKey(day);
                  const posts = byDay.get(key) ?? [];
                  const inMonth = day.getMonth() === cursor.month;
                  const isToday = key === dayKey(today);
                  return (
                    <td key={key} className="h-28 border border-neutral-200 p-1 align-top dark:border-neutral-800">
                      <div className="flex justify-between">
                        <span
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                            isToday ? "bg-foreground font-semibold text-background" : inMonth ? "" : "text-neutral-400"
                          }`}
                        >
                          {day.getDate()}
                        </span>
                        {inMonth && day >= today ? (
                          <IfCanEdit>
                            <Link href="/posts/new" aria-label={`Create a post`} className="text-xs text-neutral-400 hover:text-foreground">
                              +
                            </Link>
                          </IfCanEdit>
                        ) : null}
                      </div>
                      <ul className="mt-1 flex flex-col gap-1">
                        {posts.slice(0, 3).map((p) => (
                          <li key={p.id}>
                            <Link
                              href={`/posts/${p.id}`}
                              title={p.caption}
                              className={`block truncate rounded px-1.5 py-0.5 text-xs ${chipTone[p.status] ?? chipTone.SCHEDULED}`}
                            >
                              {p.targets.some((t) => t.risk) ? "⚠ " : ""}
                              {formatTime(postDate(p))} {p.caption || "No caption"}
                            </Link>
                          </li>
                        ))}
                        {posts.length > 3 ? <li className="px-1 text-xs text-neutral-500">+{posts.length - 3} more</li> : null}
                      </ul>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="mt-10" aria-labelledby="agenda-heading">
        <h2 id="agenda-heading" className="text-sm font-medium text-neutral-500">
          Next {AGENDA_DAYS} days
        </h2>
        {agenda === null ? null : agenda.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">
            Nothing scheduled.{" "}
            <IfCanEdit>
              <Link href="/posts/new" className="font-medium text-foreground underline">
                Schedule a post
              </Link>
            </IfCanEdit>
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {agenda.map((p) => (
              <li key={p.id}>
                <Link href={`/posts/${p.id}`} className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-3 py-2 hover:border-neutral-400 dark:border-neutral-800">
                  <div className="min-w-0">
                    <p className="text-xs text-neutral-500">{formatDateTime(postDate(p))}</p>
                    <p className="truncate text-sm">{p.caption || "No caption"}</p>
                    {p.targets.some((t) => t.risk) ? <p className="text-xs text-amber-700 dark:text-amber-400">⚠ Needs attention</p> : null}
                  </div>
                  <PostStatusBadge status={p.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Wrapper>
  );
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Calendar</h1>
        <IfCanEdit>
          <Link href="/posts/new" className="inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-sm font-medium text-background">
            Create post
          </Link>
        </IfCanEdit>
      </div>
      {children}
    </div>
  );
}
