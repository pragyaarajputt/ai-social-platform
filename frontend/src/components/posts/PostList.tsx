"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { Alert } from "@/components/ui/Alert";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { ApiError } from "@/lib/api";
import { listPosts, type Post } from "@/lib/posts";
import { PostStatusBadge } from "./PostStatusBadge";

export function PostList() {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id;
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    listPosts(workspaceId).then(
      (p) => active && setPosts(p),
      (err: unknown) => active && setError(err instanceof ApiError ? err.message : "Couldn't load posts."),
    );
    return () => {
      active = false;
    };
  }, [workspaceId]);

  if (error) return <Page><Alert tone="error">{error}</Alert></Page>;
  if (!posts) return <PageLoading />;

  return (
    <Page>
      {posts.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No posts yet.{" "}
          <Link href="/posts/new" className="font-medium text-foreground underline">
            Create your first post
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
                    {new Date(p.createdAt).toLocaleString()} · {p.targets.map((t) => `@${t.account.username}`).join(", ")}
                  </p>
                </div>
                <PostStatusBadge status={p.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Posts</h1>
        <Link href="/posts/new" className="inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-sm font-medium text-background">
          Create post
        </Link>
      </div>
      {children}
    </div>
  );
}
