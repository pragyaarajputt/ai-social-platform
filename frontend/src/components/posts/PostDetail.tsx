"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { ApiError } from "@/lib/api";
import { formatLabel } from "@/lib/instagramRules";
import { getPost, isInProgress, retryTarget, type Post, type PostTarget } from "@/lib/posts";
import { PostStatusBadge } from "./PostStatusBadge";

const POLL_MS = 3000;

export function PostDetail({ postId }: { postId: string }) {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id;
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  const inProgress = post?.targets.some((t) => isInProgress(t.status)) ?? true;

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      getPost(workspaceId, postId).then(
        (p) => {
          if (!active) return;
          setPost(p);
          setError(null);
          // Keep polling while any account is still being published to.
          if (p.targets.some((t) => isInProgress(t.status))) timer = setTimeout(load, POLL_MS);
        },
        (err: unknown) => active && setError(err instanceof ApiError ? err.message : "Couldn't load this post."),
      );
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [workspaceId, postId, refresh]);

  if (error && !post) return <Page><Alert tone="error">{error}</Alert></Page>;
  if (!post) return <PageLoading />;

  async function retry(target: PostTarget) {
    setRetrying(target.id);
    try {
      setPost(await retryTarget(workspaceId!, postId, target.id));
      setRefresh((r) => r + 1); // restart polling
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't retry. Try again.");
    } finally {
      setRetrying(null);
    }
  }

  return (
    <Page status={post}>
      {error ? <Alert tone="error">{error}</Alert> : null}
      <div className="mt-4 flex gap-3 overflow-x-auto">
        {post.media.map((m, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={m.id} src={m.thumbnailUrl} alt={`Item ${i + 1}`} className="h-28 w-28 shrink-0 rounded-lg object-cover" />
        ))}
      </div>
      {post.caption ? <p className="mt-4 whitespace-pre-wrap text-sm">{post.caption}</p> : null}

      <h2 className="mt-8 text-sm font-medium text-neutral-500">Accounts</h2>
      <ul className="mt-2 flex flex-col gap-3">
        {post.targets.map((t) => (
          <li key={t.id} className="rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">@{t.account.username}</p>
                <p className="text-sm text-neutral-500">Instagram · {formatLabel[t.format]}</p>
              </div>
              <PostStatusBadge status={t.status} />
            </div>
            {t.status === "PUBLISHED" ? (
              <p className="mt-3 text-sm">
                {t.permalink ? (
                  <a href={t.permalink} target="_blank" rel="noopener noreferrer" className="font-medium underline">
                    View on Instagram ↗
                  </a>
                ) : (
                  <span className="text-neutral-500">Published. Instagram didn&apos;t return a link.</span>
                )}
              </p>
            ) : null}
            {t.status === "QUEUED" && t.attempts > 0 ? (
              <p className="mt-3 text-sm text-neutral-500">
                Attempt {t.attempts} didn&apos;t work ({t.lastError}). Trying again
                {t.nextAttemptAt ? ` at ${new Date(t.nextAttemptAt).toLocaleTimeString()}` : " soon"}.
              </p>
            ) : null}
            {t.status === "WAITING_FOR_MEDIA" ? (
              <p className="mt-3 text-sm text-neutral-500">Instagram is processing the video. This can take a few minutes.</p>
            ) : null}
            {t.status === "FAILED" ? (
              <div className="mt-3 flex flex-col gap-3">
                <p className="text-sm text-red-700 dark:text-red-400">{t.lastError}</p>
                <div className="flex gap-2">
                  {t.account.status === "ACTIVE" ? (
                    <div>
                      <Button variant="secondary" loading={retrying === t.id} onClick={() => retry(t)}>
                        Retry
                      </Button>
                    </div>
                  ) : (
                    <Link href="/accounts" className="text-sm font-medium underline">
                      Reconnect @{t.account.username}, then retry
                    </Link>
                  )}
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {inProgress ? <p className="mt-4 text-xs text-neutral-500">This page updates automatically.</p> : null}
    </Page>
  );
}

function Page({ children, status }: { children: React.ReactNode; status?: Post }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <Link href="/posts" className="text-sm text-neutral-500 hover:underline">
        ← All posts
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Post</h1>
        {status ? <PostStatusBadge status={status.status} /> : null}
      </div>
      {status ? <p className="text-sm text-neutral-500">Created {new Date(status.createdAt).toLocaleString()}</p> : null}
      {children}
    </div>
  );
}
