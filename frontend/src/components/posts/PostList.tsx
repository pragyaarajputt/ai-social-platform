"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { Alert } from "@/components/ui/Alert";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/dates";
import { listPosts, type Post, type PostStatus } from "@/lib/posts";
import { PostStatusBadge } from "./PostStatusBadge";

const TABS: { key: string; label: string; status?: PostStatus[] }[] = [
  { key: "scheduled", label: "Scheduled", status: ["SCHEDULED"] },
  { key: "published", label: "Published", status: ["PUBLISHED", "PARTIALLY_FAILED"] },
  { key: "failed", label: "Failed", status: ["FAILED", "PARTIALLY_FAILED"] },
  { key: "all", label: "All" },
];

export function PostList() {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id;
  const router = useRouter();
  const tabKey = useSearchParams().get("tab") ?? "all";
  const tab = TABS.find((t) => t.key === tabKey) ?? TABS[3]!;
  const [loaded, setLoaded] = useState<{ key: string; posts: Post[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    listPosts(workspaceId, { status: tab.status }).then(
      (posts) => active && setLoaded({ key: tab.key, posts }),
      (err: unknown) => active && setError(err instanceof ApiError ? err.message : "Couldn't load posts."),
    );
    return () => {
      active = false;
    };
  }, [workspaceId, tab]);

  const posts = loaded?.key === tab.key ? loaded.posts : null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Posts</h1>
        <Link href="/posts/new" className="inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-sm font-medium text-background">
          Create post
        </Link>
      </div>

      <div role="tablist" aria-label="Filter posts" className="mb-4 flex gap-1 border-b border-neutral-200 dark:border-neutral-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === tab.key}
            onClick={() => router.replace(t.key === "all" ? "/posts" : `/posts?tab=${t.key}`)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              t.key === tab.key ? "border-foreground font-medium" : "border-transparent text-neutral-500 hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : !posts ? (
        <PageLoading />
      ) : posts.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700">
          {tab.key === "scheduled" ? "Nothing scheduled." : "No posts here yet."}{" "}
          <Link href="/posts/new" className="font-medium text-foreground underline">
            Create a post
          </Link>
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {posts.map((p) => (
            <li key={p.id}>
              <Link
                href={`/posts/${p.id}`}
                className="flex items-center gap-4 rounded-2xl border border-neutral-200 p-3 transition hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
              >
                {p.media[0] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.media[0].thumbnailUrl} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" />
                ) : (
                  <div className="h-16 w-16 shrink-0 rounded-lg bg-neutral-100 dark:bg-neutral-900" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{p.caption || <span className="text-neutral-500">No caption</span>}</p>
                  <p className="mt-1 text-xs text-neutral-500">
                    {p.status === "SCHEDULED" && p.scheduledAt
                      ? `${formatDateTime(new Date(p.scheduledAt))} (${formatRelative(new Date(p.scheduledAt))})`
                      : new Date(p.createdAt).toLocaleString()}{" "}
                    · {p.targets.map((t) => `@${t.account.username}`).join(", ")}
                  </p>
                  {p.targets.some((t) => t.risk) ? (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">⚠ Needs attention before it goes out</p>
                  ) : null}
                </div>
                <PostStatusBadge status={p.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
