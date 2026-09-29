"use client";

import { canEditPosts } from "@/lib/team";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { engagementRate, formatCount, formatPercent } from "@/lib/analytics";
import { ApiError } from "@/lib/api";
import { formatDateTime, formatRelative, localTimeZone } from "@/lib/dates";
import { accountLabel, formatLabel, platformName } from "@/lib/platforms";
import { PlatformIcon } from "@/components/PlatformIcon";
import { cancelPost, deletePost, getPost, isInProgress, retryTarget, riskMessage, updatePost, type Post, type PostTarget } from "@/lib/posts";
import { PostStatusBadge } from "./PostStatusBadge";

const POLL_MS = 3000;
/** Scheduled posts are re-checked this often once their time is near, so the page follows along. */
const NEAR_SCHEDULE_POLL_MS = 10_000;
const NEAR_SCHEDULE_MS = 5 * 60_000;

type Confirm = "cancel" | "publish" | "delete" | null;

export function PostDetail({ postId }: { postId: string }) {
  const { workspace } = useWorkspace();
  const canEdit = workspace ? canEditPosts(workspace.role) : false;
  const router = useRouter();
  const workspaceId = workspace?.id;
  const [post, setPost] = useState<Post | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
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
          if (p.targets.some((t) => isInProgress(t.status))) timer = setTimeout(load, POLL_MS);
          else if (p.status === "SCHEDULED" && p.scheduledAt && new Date(p.scheduledAt).getTime() - Date.now() < NEAR_SCHEDULE_MS) {
            timer = setTimeout(load, NEAR_SCHEDULE_POLL_MS);
          }
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

  async function run(key: string, action: () => Promise<Post | void>) {
    setBusy(key);
    setError(null);
    try {
      const updated = await action();
      if (updated) setPost(updated);
      setConfirm(null);
      setRefresh((r) => r + 1); // restart polling
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const scheduled = post.status === "SCHEDULED";
  const deletable = (post.status === "SCHEDULED" || post.status === "CANCELLED" || post.status === "FAILED") && !post.targets.some((t) => t.permalink);
  const risky = post.targets.filter((t) => t.risk);

  return (
    <Page post={post}>
      {error ? <Alert tone="error">{error}</Alert> : null}

      {scheduled && post.scheduledAt && canEdit ? (
        <div className="mt-4 rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm">
            Scheduled for <strong>{formatDateTime(new Date(post.scheduledAt))}</strong>{" "}
            <span className="text-neutral-500">
              ({formatRelative(new Date(post.scheduledAt))} · {localTimeZone()})
            </span>
          </p>
          {risky.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1 text-sm text-amber-800 dark:text-amber-300">
              {risky.map((t) => (
                <li key={t.id}>
                  ⚠ {riskMessage(t.risk!, t.account)}{" "}
                  <Link href="/accounts" className="font-medium underline">
                    Fix
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {confirm === "publish" || confirm === "cancel" ? (
            <div className="mt-4 flex flex-col gap-2 rounded-xl bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
              <p>{confirm === "publish" ? "Publish this post now instead of at the scheduled time?" : "Cancel this scheduled post? It won't be published."}</p>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirm(null)}>
                  Keep scheduled
                </Button>
                <Button
                  variant={confirm === "cancel" ? "danger" : "primary"}
                  loading={busy === confirm}
                  onClick={() =>
                    run(confirm, () =>
                      confirm === "publish" ? updatePost(workspaceId!, postId, { scheduledAt: null }) : cancelPost(workspaceId!, postId),
                    )
                  }
                >
                  {confirm === "publish" ? "Publish now" : "Cancel post"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href={`/posts/${post.id}/edit`}
                className="inline-flex h-10 items-center rounded-lg bg-foreground px-4 text-sm font-medium text-background"
              >
                Edit
              </Link>
              <div>
                <Button variant="secondary" onClick={() => setConfirm("publish")}>
                  Publish now
                </Button>
              </div>
              <div>
                <Button variant="secondary" onClick={() => setConfirm("cancel")}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}

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
          <TargetRow key={t.id} target={t} canEdit={canEdit} retrying={busy === t.id} onRetry={() => run(t.id, () => retryTarget(workspaceId!, postId, t.id))} />
        ))}
      </ul>
      {inProgress ? <p className="mt-4 text-xs text-neutral-500">This page updates automatically.</p> : null}

      {deletable && canEdit ? (
        <div className="mt-10 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          {confirm === "delete" ? (
            <div className="flex flex-col gap-2 text-sm">
              <p>Delete this post? This can&apos;t be undone.</p>
              <div className="flex gap-2">
                <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirm(null)}>
                  Keep it
                </Button>
                <Button
                  variant="danger"
                  loading={busy === "delete"}
                  onClick={() =>
                    run("delete", async () => {
                      await deletePost(workspaceId!, postId);
                      router.replace("/posts");
                    })
                  }
                >
                  Delete post
                </Button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirm("delete")} className="text-sm text-red-600 hover:underline">
              Delete post
            </button>
          )}
        </div>
      ) : null}
    </Page>
  );
}

function TargetMetricsView({ target: t }: { target: PostTarget }) {
  const m = t.metrics;
  if (!m || m.status === "PENDING") return <p className="mt-2 text-xs text-neutral-500">Numbers appear about an hour after publishing.</p>;
  if (m.status === "UNAVAILABLE") return <p className="mt-2 text-xs text-neutral-500">Numbers aren&apos;t available: the post may have been removed from {platformName(t.account.platform)}.</p>;
  const rate = engagementRate(m.totalInteractions, m.reach);
  const items: [string, string][] = [
    ["Views", formatCount(m.views)],
    ["Reach", formatCount(m.reach)],
    ["Likes", formatCount(m.likes)],
    ["Comments", formatCount(m.comments)],
    ["Shares", formatCount(m.shares)],
    ["Saves", formatCount(m.saves)],
    ["Engagement", formatPercent(rate)],
    ...(m.avgWatchTimeMs != null ? ([["Avg. watch", `${(m.avgWatchTimeMs / 1000).toFixed(1)} s`]] as [string, string][]) : []),
  ];
  return (
    <div className="mt-3">
      <dl className="grid grid-cols-4 gap-2 text-center sm:grid-cols-8">
        {items.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-neutral-50 p-2 dark:bg-neutral-900">
            <dd className="text-sm font-semibold tabular-nums">{value}</dd>
            <dt className="text-[11px] text-neutral-500">{label}</dt>
          </div>
        ))}
      </dl>
      {m.fetchedAt ? <p className="mt-1 text-xs text-neutral-500">Updated {new Date(m.fetchedAt).toLocaleString()} · {platformName(t.account.platform)} can be up to 48 h behind</p> : null}
    </div>
  );
}

function TargetRow({ target: t, canEdit, retrying, onRetry }: { target: PostTarget; canEdit: boolean; retrying: boolean; onRetry: () => void }) {
  return (
    <li className="rounded-2xl border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 font-medium">
            <PlatformIcon platform={t.account.platform} />
            {accountLabel(t.account)}
          </p>
          <p className="text-sm text-neutral-500">
            {platformName(t.account.platform)} · {formatLabel(t.format, t.account.platform)}
          </p>
        </div>
        <PostStatusBadge status={t.status} />
      </div>
      {t.status === "PUBLISHED" ? (
        <p className="mt-3 text-sm">
          {t.permalink ? (
            <a href={t.permalink} target="_blank" rel="noopener noreferrer" className="font-medium underline">
              View on {platformName(t.account.platform)} ↗
            </a>
          ) : (
            <span className="text-neutral-500">Published. {platformName(t.account.platform)} didn&apos;t return a link.</span>
          )}
        </p>
      ) : null}
      {t.status === "PUBLISHED" ? <TargetMetricsView target={t} /> : null}
      {t.status === "QUEUED" && t.attempts > 0 ? (
        <p className="mt-3 text-sm text-neutral-500">
          Attempt {t.attempts} didn&apos;t work ({t.lastError}). Trying again
          {t.nextAttemptAt ? ` at ${new Date(t.nextAttemptAt).toLocaleTimeString()}` : " soon"}.
        </p>
      ) : null}
      {t.status === "WAITING_FOR_MEDIA" ? (
        <p className="mt-3 text-sm text-neutral-500">{platformName(t.account.platform)} is processing the video. This can take a few minutes.</p>
      ) : null}
      {t.status === "FAILED" ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm text-red-700 dark:text-red-400">{t.lastError}</p>
          <div className="flex gap-2">
            {!canEdit ? null : t.account.status === "ACTIVE" ? (
              <div>
                <Button variant="secondary" loading={retrying} onClick={onRetry}>
                  Retry
                </Button>
              </div>
            ) : (
              <Link href="/accounts" className="text-sm font-medium underline">
                Reconnect {accountLabel(t.account)}, then retry
              </Link>
            )}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Page({ children, post }: { children: React.ReactNode; post?: Post }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <Link href="/posts" className="text-sm text-neutral-500 hover:underline">
        ← All posts
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Post</h1>
        {post ? <PostStatusBadge status={post.status} /> : null}
      </div>
      {post ? <p className="text-sm text-neutral-500">Created {new Date(post.createdAt).toLocaleString()}</p> : null}
      {children}
    </div>
  );
}
