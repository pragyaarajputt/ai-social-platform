"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { ApiError } from "@/lib/api";
import { countHashtags, countMentions, formatLabel, INSTAGRAM, instagramFormat, instagramProblems } from "@/lib/instagramRules";
import { createPost, uploadMedia, type MediaItem } from "@/lib/posts";
import { listSocialAccounts, type SocialAccount } from "@/lib/workspaces";

interface Upload {
  key: number;
  name: string;
  progress: number;
  error?: string;
}

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime";

export function Composer() {
  const { workspace } = useWorkspace();
  const router = useRouter();
  const workspaceId = workspace?.id;

  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [caption, setCaption] = useState("");
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string | undefined>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadKey = useRef(0);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    listSocialAccounts(workspaceId).then(
      ({ accounts }) => {
        if (!active) return;
        setAccounts(accounts);
        // Preselect when there's exactly one account ready to publish.
        const ready = accounts.filter((a) => a.status === "ACTIVE");
        if (ready.length === 1) setSelected([ready[0]!.id]);
      },
      () => active && setAccounts([]),
    );
    return () => {
      active = false;
    };
  }, [workspaceId]);

  if (!workspaceId || accounts === null) return <PageLoading />;

  const ready = accounts.filter((a) => a.status === "ACTIVE");
  const notReady = accounts.filter((a) => a.status !== "ACTIVE");
  const format = instagramFormat(media);
  const uploading = uploads.some((u) => !u.error);
  const problemsFor = (accountId: string) => instagramProblems(overrides[accountId] ?? caption, media);
  const problems = Array.from(new Set(selected.flatMap(problemsFor)));
  const canPublish = selected.length > 0 && problems.length === 0 && !uploading && !submitting;

  function addFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const key = ++uploadKey.current;
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      uploadMedia(workspaceId!, file, (progress) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress } : x)))).then(
        (item) => {
          setMedia((m) => [...m, item]);
          setUploads((u) => u.filter((x) => x.key !== key));
        },
        (err: unknown) => {
          const message = err instanceof ApiError ? err.message : "Upload failed.";
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: message } : x)));
        },
      );
    }
  }

  function move(index: number, by: -1 | 1) {
    setMedia((m) => {
      const next = [...m];
      const [item] = next.splice(index, 1);
      next.splice(index + by, 0, item!);
      return next;
    });
  }

  async function publish() {
    setSubmitting(true);
    setServerErrors([]);
    try {
      const post = await createPost(workspaceId!, {
        caption,
        mediaIds: media.map((m) => m.id),
        targets: selected.map((id) => ({ socialAccountId: id, captionOverride: overrides[id] })),
      });
      router.push(`/posts/${post.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.length) setServerErrors(err.fieldErrors.map((f) => f.message));
      else setServerErrors([err instanceof ApiError ? err.message : "Couldn't create the post. Try again."]);
      setSubmitting(false);
    }
  }

  if (ready.length === 0) {
    return (
      <Page>
        <Alert tone="info">
          Connect an Instagram account before creating a post.{" "}
          <Link href="/accounts" className="font-medium underline">
            Go to accounts
          </Link>
        </Alert>
      </Page>
    );
  }

  return (
    <Page>
      <div className="grid gap-8 lg:grid-cols-[1fr_18rem]">
        <div className="flex flex-col gap-6">
          {/* Media */}
          <section aria-labelledby="media-heading">
            <h2 id="media-heading" className="text-sm font-medium">
              Photos and videos
            </h2>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }}
              className={`mt-2 rounded-2xl border-2 border-dashed p-4 transition ${
                dragging ? "border-blue-500 bg-blue-50 dark:bg-blue-950" : "border-neutral-300 dark:border-neutral-700"
              }`}
            >
              {media.length > 0 ? (
                <ol className="mb-4 grid grid-cols-3 gap-3 sm:grid-cols-4">
                  {media.map((m, i) => (
                    <li key={m.id} className="group relative">
                      {/* Cloudinary thumbnail; next/image's allowlist isn't worth it for previews. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.thumbnailUrl} alt={`Item ${i + 1}`} className="aspect-square w-full rounded-lg object-cover" />
                      <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 text-xs text-white">
                        {i + 1}
                        {m.type === "VIDEO" ? " · video" : ""}
                      </span>
                      <div className="mt-1 flex justify-between text-xs">
                        <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move item ${i + 1} earlier`} className="px-1 disabled:opacity-30">
                          ←
                        </button>
                        <button type="button" onClick={() => setMedia((x) => x.filter((y) => y.id !== m.id))} className="text-red-600 hover:underline">
                          Remove
                        </button>
                        <button
                          type="button"
                          disabled={i === media.length - 1}
                          onClick={() => move(i, 1)}
                          aria-label={`Move item ${i + 1} later`}
                          className="px-1 disabled:opacity-30"
                        >
                          →
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : null}

              {uploads.length > 0 ? (
                <ul className="mb-4 flex flex-col gap-2 text-sm">
                  {uploads.map((u) => (
                    <li key={u.key}>
                      <div className="flex justify-between gap-2">
                        <span className="truncate">{u.name}</span>
                        {u.error ? (
                          <button type="button" className="shrink-0 text-neutral-500 hover:underline" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>
                            Dismiss
                          </button>
                        ) : (
                          <span className="shrink-0 text-neutral-500">{Math.round(u.progress * 100)}%</span>
                        )}
                      </div>
                      {u.error ? (
                        <p className="text-red-600 dark:text-red-400">{u.error}</p>
                      ) : (
                        <div className="mt-1 h-1.5 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800">
                          <div className="h-full bg-blue-500 transition-all" style={{ width: `${u.progress * 100}%` }} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}

              <div className="flex flex-col items-center gap-2 py-2 text-center text-sm text-neutral-500">
                <p>Drag files here, or</p>
                <div>
                  <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()} disabled={media.length >= INSTAGRAM.carouselMax}>
                    Choose files
                  </Button>
                </div>
                <p className="text-xs">JPEG, PNG, WebP or HEIC images · MP4 or MOV videos · up to 10 items</p>
                <input
                  ref={fileInput}
                  type="file"
                  accept={ACCEPT}
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
          </section>

          {/* Caption */}
          <section>
            <label htmlFor="caption" className="text-sm font-medium">
              Caption
            </label>
            <textarea
              id="caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={6}
              placeholder="Write a caption…"
              className="mt-2 w-full rounded-xl border border-neutral-300 bg-transparent p-3 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-neutral-700"
            />
            <CaptionCounters text={caption} />
          </section>
        </div>

        {/* Accounts + publish */}
        <aside className="flex flex-col gap-4">
          <section aria-labelledby="accounts-heading">
            <h2 id="accounts-heading" className="text-sm font-medium">
              Publish to
            </h2>
            <ul className="mt-2 flex flex-col gap-2">
              {ready.map((a) => {
                const checked = selected.includes(a.id);
                return (
                  <li key={a.id} className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setSelected((s) => (checked ? s.filter((x) => x !== a.id) : [...s, a.id]))}
                      />
                      <span className="font-medium">@{a.username}</span>
                      <span className="text-neutral-500">Instagram</span>
                    </label>
                    {checked ? (
                      overrides[a.id] === undefined ? (
                        <button type="button" onClick={() => setOverrides((o) => ({ ...o, [a.id]: caption }))} className="mt-2 text-xs text-neutral-500 hover:underline">
                          Customize caption for this account
                        </button>
                      ) : (
                        <div className="mt-2">
                          <textarea
                            aria-label={`Caption for @${a.username}`}
                            value={overrides[a.id]}
                            onChange={(e) => setOverrides((o) => ({ ...o, [a.id]: e.target.value }))}
                            rows={3}
                            className="w-full rounded-lg border border-neutral-300 bg-transparent p-2 text-xs dark:border-neutral-700"
                          />
                          <button
                            type="button"
                            onClick={() => setOverrides((o) => ({ ...o, [a.id]: undefined }))}
                            className="text-xs text-neutral-500 hover:underline"
                          >
                            Use the main caption
                          </button>
                        </div>
                      )
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {notReady.length > 0 ? (
              <p className="mt-2 text-xs text-neutral-500">
                {notReady.map((a) => `@${a.username}`).join(", ")} {notReady.length === 1 ? "needs" : "need"} reconnecting.{" "}
                <Link href="/accounts" className="underline">
                  Fix
                </Link>
              </p>
            ) : null}
          </section>

          <section className="rounded-xl bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
            <p>
              Format: <strong>{format ? `${formatLabel[format]}${format === "CAROUSEL" ? ` (${media.length} items)` : ""}` : "—"}</strong>
            </p>
            {problems.length > 0 && selected.length > 0 ? (
              <ul className="mt-2 list-disc pl-4 text-amber-800 dark:text-amber-300">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            ) : null}
          </section>

          {serverErrors.length > 0 ? (
            <Alert tone="error">
              <ul className="list-disc pl-4">
                {serverErrors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          <Button onClick={publish} disabled={!canPublish} loading={submitting}>
            Publish now
          </Button>
          {selected.length === 0 ? <p className="text-center text-xs text-neutral-500">Choose at least one account.</p> : null}
          {uploading ? <p className="text-center text-xs text-neutral-500">Waiting for uploads to finish…</p> : null}
        </aside>
      </div>
    </Page>
  );
}

function CaptionCounters({ text }: { text: string }) {
  const items: [string, number, number][] = [
    ["characters", text.length, INSTAGRAM.captionMax],
    ["hashtags", countHashtags(text), INSTAGRAM.hashtagMax],
    ["mentions", countMentions(text), INSTAGRAM.mentionMax],
  ];
  return (
    <p className="mt-1 flex flex-wrap gap-x-4 text-xs text-neutral-500">
      {items.map(([label, n, max]) => (
        <span key={label} className={n > max ? "font-medium text-red-600 dark:text-red-400" : undefined}>
          {n} / {max} {label}
        </span>
      ))}
    </p>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Create post</h1>
      <div className="mt-6">{children}</div>
    </div>
  );
}
