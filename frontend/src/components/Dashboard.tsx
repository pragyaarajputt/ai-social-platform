"use client";

import { IfCanEdit } from "@/components/workspace/IfCanEdit";
import { canEditPosts } from "@/lib/team";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { formatDateTime, formatRelative } from "@/lib/dates";
import { listAtRisk, listPosts, riskMessage, type AtRiskItem, type Post } from "@/lib/posts";
import { listSocialAccounts, type SocialAccount } from "@/lib/workspaces";
import { PageLoading } from "./auth/RequireAuth";
import { PostStatusBadge } from "./posts/PostStatusBadge";

interface DashboardData {
  accounts: SocialAccount[];
  recent: Post[];
  upcoming: Post[];
  atRisk: AtRiskItem[];
}

/** The signed-in home page: accounts, what's coming up, what needs attention, and recent posts. */
export function Dashboard() {
  const { user } = useAuth();
  const { workspace, status } = useWorkspace();
  const [data, setData] = useState<DashboardData | null>(null);
  const workspaceId = workspace?.id;

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    const orEmpty = <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);
    Promise.all([
      listSocialAccounts(workspaceId).then((d) => d.accounts).catch(() => []),
      orEmpty(listPosts(workspaceId)),
      orEmpty(listPosts(workspaceId, { status: ["SCHEDULED"] })),
      orEmpty(listAtRisk(workspaceId)),
    ]).then(([accounts, recent, upcoming, atRisk]) => active && setData({ accounts, recent, upcoming, atRisk }));
    return () => {
      active = false;
    };
  }, [workspaceId]);

  if (status === "loading" || (status === "ready" && data === null)) return <PageLoading />;

  const accounts = data?.accounts ?? [];
  const needsAttention = accounts.filter((a) => a.status !== "ACTIVE");
  const next = data?.upcoming[0];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Hi, {user?.displayName ?? user?.username}</h1>
      <p className="mt-1 text-sm text-neutral-500">{workspace?.name}</p>

      {data && data.atRisk.length > 0 ? (
        <div className="mt-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">
            {data.atRisk.length === 1 ? "A post due in the next 24 hours" : `${data.atRisk.length} posts due in the next 24 hours`} will
            probably fail:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {data.atRisk.map((r) => (
              <li key={r.targetId}>
                <Link href={`/posts/${r.postId}`} className="underline">
                  {formatDateTime(new Date(r.scheduledAt))}
                </Link>{" "}
                — {riskMessage(r.risk, r.account)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Link
          href="/accounts"
          className="rounded-2xl border border-neutral-200 p-5 transition hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
        >
          <p className="text-sm text-neutral-500">Connected accounts</p>
          <p className="mt-1 text-3xl font-semibold">{accounts.length}</p>
          <p className="mt-2 text-sm">{accounts.length ? "Manage accounts →" : "Connect your first account →"}</p>
        </Link>
        <Link
          href="/calendar"
          className="rounded-2xl border border-neutral-200 p-5 transition hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
        >
          <p className="text-sm text-neutral-500">Scheduled</p>
          <p className="mt-1 text-3xl font-semibold">{data?.upcoming.length ?? 0}</p>
          <p className="mt-2 truncate text-sm">
            {next?.scheduledAt ? `Next ${formatRelative(new Date(next.scheduledAt))} →` : "Open calendar →"}
          </p>
        </Link>
        <Link
          href={workspace && canEditPosts(workspace.role) ? "/posts/new" : "/posts"}
          className="rounded-2xl border border-neutral-200 p-5 transition hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
        >
          <p className="text-sm text-neutral-500">Posts</p>
          <p className="mt-1 text-3xl font-semibold">{data?.recent.length ?? 0}</p>
          <p className="mt-2 text-sm">
            <IfCanEdit otherwise="See all posts →">Create a post →</IfCanEdit>
          </p>
        </Link>
      </div>

      {needsAttention.length > 0 ? (
        <p className="mt-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {needsAttention.length === 1 ? "1 account needs" : `${needsAttention.length} accounts need`} attention.{" "}
          <Link href="/accounts" className="font-medium underline">
            Review
          </Link>
        </p>
      ) : null}

      {data && data.recent.length > 0 ? (
        <section className="mt-10">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-neutral-500">Recent posts</h2>
            <Link href="/posts" className="text-sm hover:underline">
              See all
            </Link>
          </div>
          <ul className="mt-3 flex flex-col gap-2">
            {data.recent.slice(0, 5).map((p) => (
              <li key={p.id}>
                <Link href={`/posts/${p.id}`} className="flex items-center justify-between gap-3 rounded-xl px-2 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-900">
                  <span className="truncate text-sm">{p.caption || "No caption"}</span>
                  <PostStatusBadge status={p.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
