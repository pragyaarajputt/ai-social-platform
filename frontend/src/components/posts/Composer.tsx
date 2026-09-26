"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AiAssistant } from "@/components/ai/AiAssistant";
import { BestTimeHint } from "@/components/analytics/BestTimeHint";
import { PageLoading } from "@/components/auth/RequireAuth";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { ApiError } from "@/lib/api";
import { PlatformIcon } from "@/components/PlatformIcon";
import { countHashtags, countMentions, INSTAGRAM } from "@/lib/instagramRules";
import { CAPTION_MAX, formatFor, formatLabel, platformName, problemsFor as platformProblems } from "@/lib/platforms";
import { formatDateTime, formatRelative, fromDateTimeLocal, localTimeZone, toDateTimeLocal, useNow } from "@/lib/dates";
import { createPost, updatePost, uploadMedia, type MediaItem, type Post } from "@/lib/posts";
import { listSocialAccounts, type SocialAccount } from "@/lib/workspaces";

interface Upload {
  key: number;
  name: string;
  progress: number;
  error?: string;
}

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime";

/** Earliest time the picker offers; the server requires at least 2 minutes. */
const MIN_LEAD_MS = 5 * 60_000;
const SERVER_MIN_LEAD_MS = 2 * 60_000;

/** Creates a post, or edits `initialPost` (a scheduled post) when given. */
export function Composer({ initialPost }: { initialPost?: Post }) {
  const { workspace } = useWorkspace();
  const router = useRouter();
  const workspaceId = workspace?.id;
  const editing = initialPost !== undefined;

  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [caption, setCaption] = useState(initialPost?.caption ?? "");
  const [media, setMedia] = useState<MediaItem[]>(initialPost?.media ?? []);
  const [uploads, setUploads] = useState<Upload[]>([]);
  // Accounts cancelled out of a scheduled post (e.g. disconnected) aren't part of it any more.
  const initialTargets = initialPost?.targets.filter((t) => t.status !== "CANCELLED");
  const [selected, setSelected] = useState<string[]>(initialTargets?.map((t) => t.account.id) ?? []);
  const [overrides, setOverrides] = useState<Record<string, string | undefined>>(
    Object.fromEntries(initialTargets?.filter((t) => t.caption !== null).map((t) => [t.account.id, t.caption!]) ?? []),
  );
  const [mode, setMode] = useState<"now" | "schedule">(initialPost?.scheduledAt ? "schedule" : "now");
  const initialWhen = initialPost?.scheduledAt ? toDateTimeLocal(new Date(initialPost.scheduledAt)) : "";
  const [when, setWhen] = useState(initialWhen);
  const [submitting, setSubmitting] = useState(false);
  const [aiAssisted, setAiAssisted] = useState(initialPost?.aiAssisted ?? false);
  const now = useNow();
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
        // New posts: preselect when there's exactly one account ready to publish.
        const ready = accounts.filter((a) => a.status === "ACTIVE");
        if (!editing && ready.length === 1) setSelected([ready[0]!.id]);
      },
      () => active && setAccounts([]),
    );
    return () => {
      active = false;
    };
  }, [workspaceId, editing]);

  if (!workspaceId || accounts === null) return <PageLoading />;

  const ready = accounts.filter((a) => a.status === "ACTIVE");
  const notReady = accounts.filter((a) => a.status !== "ACTIVE");
  const uploading = uploads.some((u) => !u.error);
  const platformOf = (accountId: string) => accounts.find((a) => a.id === accountId)?.platform ?? "INSTAGRAM";
  const problemsFor = (accountId: string) => platformProblems(platformOf(accountId), overrides[accountId] ?? caption, media);
  // The platforms being posted to (every connected one while nothing is selected), for counters and format.
  const selectedPlatforms = Array.from(new Set((selected.length ? selected : ready.map((a) => a.id)).map(platformOf)));
  const scheduledFor = mode === "schedule" ? fromDateTimeLocal(when) : null;
  // Mirrors the server: only a newly chosen time has to be at least 2 minutes ahead.
  const timeChanged = !editing || when !== initialWhen || mode !== "schedule";
  const scheduleProblem =
    mode !== "schedule"
      ? null
      : !scheduledFor
        ? "Pick a date and time."
        : timeChanged && scheduledFor.getTime() - now < SERVER_MIN_LEAD_MS
          ? "Pick a time at least a few minutes from now, or publish now."
          : null;
  // Selected accounts that can't be published to (e.g. an edited post whose account now needs
  // reconnecting, or was disconnected). They must be removed or reconnected before saving.
  const staleSelected = selected.filter((id) => !ready.some((a) => a.id === id));
  const staleName = (id: string) =>
    accounts.find((a) => a.id === id)?.username ?? initialPost?.targets.find((t) => t.account.id === id)?.account.username ?? "an account";
  const problems = Array.from(
    new Set([
      // With several platforms selected, each problem says which one it's about.
      ...selected
        .filter((id) => !staleSelected.includes(id))
        .flatMap((id) => problemsFor(id).map((p) => (selectedPlatforms.length > 1 ? `${platformName(platformOf(id))}: ${p}` : p))),
      ...staleSelected.map((id) => `Remove @${staleName(id)} or reconnect it first.`),
      ...(scheduleProblem ? [scheduleProblem] : []),
    ]),
  );
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
    const content = {
      caption,
      mediaIds: media.map((m) => m.id),
      targets: selected.map((id) => ({ socialAccountId: id, captionOverride: overrides[id] })),
      aiAssisted,
    };
    try {
      const post = editing
        ? await updatePost(workspaceId!, initialPost.id, {
            ...content,
            // Unchanged time: leave it out, so the server keeps it as is.
            ...(timeChanged && { scheduledAt: scheduledFor ? scheduledFor.toISOString() : null }),
          })
        : await createPost(workspaceId!, { ...content, ...(scheduledFor && { scheduledAt: scheduledFor.toISOString() }) });
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
          Connect an Instagram account or a Facebook Page before creating a post.{" "}
          <Link href="/accounts" className="font-medium underline">
            Go to accounts
          </Link>
        </Alert>
      </Page>
    );
  }

  return (
    <Page title={editing ? "Edit scheduled post" : "Create post"}>
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
            <CaptionCounters text={caption} platforms={selectedPlatforms} />
            <AiAssistant
              workspaceId={workspaceId}
              caption={caption}
              onCaptionChange={setCaption}
              mediaIds={media.map((m) => m.id)}
              onApplied={() => setAiAssisted(true)}
            />
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
                      <PlatformIcon platform={a.platform} />
                      <span className="font-medium">{a.platform === "FACEBOOK" ? a.name ?? a.username : `@${a.username}`}</span>
                      <span className="text-neutral-500">{platformName(a.platform)}</span>
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
            {staleSelected.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-2">
                {staleSelected.map((id) => (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
                  >
                    <span>
                      @{staleName(id)} can&apos;t be published to until it&apos;s{" "}
                      <Link href="/accounts" className="underline">
                        reconnected
                      </Link>
                      .
                    </span>
                    <button type="button" onClick={() => setSelected((s) => s.filter((x) => x !== id))} className="shrink-0 font-medium underline">
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {notReady.some((a) => !selected.includes(a.id)) ? (
              <p className="mt-2 text-xs text-neutral-500">
                {notReady
                  .filter((a) => !selected.includes(a.id))
                  .map((a) => `@${a.username}`)
                  .join(", ")}{" "}
                {notReady.filter((a) => !selected.includes(a.id)).length === 1 ? "needs" : "need"} reconnecting.{" "}
                <Link href="/accounts" className="underline">
                  Fix
                </Link>
              </p>
            ) : null}
          </section>

          <section className="rounded-xl bg-neutral-50 p-3 text-sm dark:bg-neutral-900">
            {selectedPlatforms.map((p) => {
              const f = formatFor(p, media);
              return (
                <p key={p}>
                  {selectedPlatforms.length > 1 ? `${platformName(p)}: ` : "Format: "}
                  <strong>{f ? `${formatLabel(f, p)}${f === "CAROUSEL" ? ` (${media.length} items)` : ""}` : "—"}</strong>
                </p>
              );
            })}
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

          <section aria-labelledby="when-heading" className="flex flex-col gap-2">
            <h2 id="when-heading" className="text-sm font-medium">
              When
            </h2>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="when" checked={mode === "now"} onChange={() => setMode("now")} />
                Publish now
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="when"
                  checked={mode === "schedule"}
                  onChange={() => {
                    setMode("schedule");
                    if (!when) setWhen(toDateTimeLocal(new Date(Date.now() + 60 * 60_000)));
                  }}
                />
                Schedule
              </label>
            </div>
            {mode === "schedule" ? (
              <>
                <input
                  type="datetime-local"
                  aria-label="Publish date and time"
                  value={when}
                  min={toDateTimeLocal(new Date(now + MIN_LEAD_MS))}
                  onChange={(e) => setWhen(e.target.value)}
                  className="h-10 rounded-lg border border-neutral-300 bg-transparent px-3 text-sm dark:border-neutral-700"
                />
                <p className="text-xs text-neutral-500">
                  {scheduledFor ? `${formatDateTime(scheduledFor)} (${formatRelative(scheduledFor, new Date(now))}) · ` : ""}
                  Times in {localTimeZone()}
                </p>
                <BestTimeHint workspaceId={workspaceId} accountId={selected.find((id) => ready.some((a) => a.id === id))} day={scheduledFor ? scheduledFor.getDay() : null} />
              </>
            ) : null}
          </section>

          <Button onClick={publish} disabled={!canPublish} loading={submitting}>
            {editing ? (mode === "now" ? "Save and publish now" : "Save changes") : mode === "now" ? "Publish now" : "Schedule"}
          </Button>
          {selected.length === 0 ? <p className="text-center text-xs text-neutral-500">Choose at least one account.</p> : null}
          {uploading ? <p className="text-center text-xs text-neutral-500">Waiting for uploads to finish…</p> : null}
        </aside>
      </div>
    </Page>
  );
}

/** Counts against the strictest selected platform; hashtag and mention limits are Instagram's. */
function CaptionCounters({ text, platforms }: { text: string; platforms: SocialAccount["platform"][] }) {
  const max = Math.min(...platforms.map((p) => CAPTION_MAX[p] ?? Infinity));
  const items: [string, number, number][] = [
    ["characters", text.length, Number.isFinite(max) ? max : INSTAGRAM.captionMax],
    ...(platforms.includes("INSTAGRAM")
      ? ([
          ["hashtags", countHashtags(text), INSTAGRAM.hashtagMax],
          ["mentions", countMentions(text), INSTAGRAM.mentionMax],
        ] as [string, number, number][])
      : []),
  ];
  return (
    <p className="mt-1 flex flex-wrap gap-x-4 text-xs text-neutral-500">
      {items.map(([label, n, max]) => (
        <span key={label} className={n > max ? "font-medium text-red-600 dark:text-red-400" : undefined}>
          {n.toLocaleString()} / {max.toLocaleString()} {label}
        </span>
      ))}
    </p>
  );
}

function Page({ children, title = "Create post" }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="mt-6">{children}</div>
    </div>
  );
}
