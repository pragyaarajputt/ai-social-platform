"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  addHashtags,
  aiErrorMessage,
  captionHasTag,
  diffWords,
  generateCaptions,
  getAiUsage,
  REWRITE_ACTIONS,
  rewriteCaption,
  sendFeedback,
  suggestHashtags,
  TONES,
  type AiUsage,
  type HashtagSuggestion,
  type RewriteAction,
  type Tone,
} from "@/lib/ai";
import { formatTime } from "@/lib/dates";

type Tool = "captions" | "hashtags" | "rewrite";

interface Props {
  workspaceId: string;
  caption: string;
  onCaptionChange: (caption: string) => void;
  mediaIds: string[];
  /** Called when the user applies any AI suggestion, so the post can be marked as AI-assisted. */
  onApplied: () => void;
}

/**
 * AI tools under the caption: write captions, suggest hashtags, rewrite. Every result is a suggestion
 * the user has to apply; applying can be undone until the caption is edited again.
 */
export function AiAssistant({ workspaceId, caption, onCaptionChange, mediaIds, onApplied }: Props) {
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [busy, setBusy] = useState<Tool | null>(null);
  const [error, setError] = useState<{ tool: Tool; message: string } | null>(null);
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);

  // Write with AI
  const [writeOpen, setWriteOpen] = useState(false);
  const [idea, setIdea] = useState("");
  const [tone, setTone] = useState<Tone>("casual");
  const [usePhotos, setUsePhotos] = useState(true);
  const [captions, setCaptions] = useState<{ requestId: string; options: string[]; rating?: 1 | -1 } | null>(null);

  // Hashtags
  const [hashtags, setHashtags] = useState<{ requestId: string; tags: HashtagSuggestion[]; used: boolean } | null>(null);

  // Rewrite
  const [action, setAction] = useState<RewriteAction>("improve");
  const [rewriteTone, setRewriteTone] = useState<Tone>("professional");
  const [rewrite, setRewrite] = useState<{ requestId: string; before: string; text: string; rating?: 1 | -1 } | null>(null);

  useEffect(() => {
    let active = true;
    getAiUsage(workspaceId).then(
      (u) => active && setUsage(u),
      () => undefined, // The tools still work; the server reports problems when they're used.
    );
    return () => {
      active = false;
    };
  }, [workspaceId]);

  if (usage && !usage.configured) {
    return <p className="mt-3 text-xs text-neutral-500">AI writing isn&apos;t set up on this server yet.</p>;
  }

  const limitReached = usage !== null && usage.usedToday >= usage.dailyLimit;
  const photoCount = mediaIds.length;

  async function runTool<T>(tool: Tool, call: () => Promise<T>): Promise<T | null> {
    setBusy(tool);
    setError(null);
    try {
      return await call();
    } catch (err) {
      setError({ tool, message: aiErrorMessage(err) });
      return null;
    } finally {
      setBusy(null);
      getAiUsage(workspaceId).then(setUsage, () => undefined);
    }
  }

  function apply(next: string) {
    setUndo({ before: caption, after: next });
    onCaptionChange(next);
    onApplied();
  }

  async function writeCaptions() {
    const res = await runTool("captions", () =>
      generateCaptions(workspaceId, { idea: idea.trim(), mediaIds: usePhotos ? mediaIds : [], tone }),
    );
    if (res) setCaptions({ requestId: res.requestId, options: res.captions });
  }

  async function findHashtags() {
    const res = await runTool("hashtags", () => suggestHashtags(workspaceId, { caption, mediaIds }));
    if (res) setHashtags({ requestId: res.requestId, tags: res.hashtags, used: false });
  }

  function addSuggestedTags(tags: string[]) {
    const result = addHashtags(caption, tags);
    if (result.added.length === 0) return;
    apply(result.caption);
    if (hashtags && !hashtags.used) {
      sendFeedback(workspaceId, hashtags.requestId, { appliedIndex: 0 });
      setHashtags({ ...hashtags, used: true });
    }
  }

  async function runRewrite() {
    const before = caption;
    const res = await runTool("rewrite", () => rewriteCaption(workspaceId, { text: before, action, ...(action === "tone" && { tone: rewriteTone }) }));
    if (res) setRewrite({ requestId: res.requestId, before, text: res.text });
  }

  const errorFor = (tool: Tool) =>
    error?.tool === tool ? (
      <p role="alert" className="text-xs text-red-600 dark:text-red-400">
        {error.message}
      </p>
    ) : null;

  const disabled = busy !== null || limitReached;
  const unusedHashtags = hashtags?.tags.filter((h) => !captionHasTag(caption, h.tag)) ?? [];

  return (
    <section aria-label="AI writing tools" className="mt-3 rounded-xl border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900 dark:bg-violet-950/30">
      <div className="flex flex-wrap items-center gap-2">
        <ToolButton pressed={writeOpen} onClick={() => setWriteOpen((o) => !o)} disabled={limitReached}>
          ✨ Write with AI
        </ToolButton>
        <ToolButton onClick={findHashtags} disabled={disabled || (!caption.trim() && photoCount === 0)} busy={busy === "hashtags"}>
          # Suggest hashtags
        </ToolButton>
        <span className="flex items-center gap-1">
          <label htmlFor="rewrite-action" className="sr-only">
            Rewrite action
          </label>
          <select
            id="rewrite-action"
            value={action}
            onChange={(e) => setAction(e.target.value as RewriteAction)}
            className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
          >
            {REWRITE_ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          {action === "tone" ? (
            <>
              <label htmlFor="rewrite-tone" className="sr-only">
                New tone
              </label>
              <select
                id="rewrite-tone"
                value={rewriteTone}
                onChange={(e) => setRewriteTone(e.target.value as Tone)}
                className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              >
                {TONES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </>
          ) : null}
          <ToolButton onClick={runRewrite} disabled={disabled || !caption.trim()} busy={busy === "rewrite"}>
            Rewrite
          </ToolButton>
        </span>
        <span className="ml-auto text-xs text-neutral-500">
          {usage ? (
            limitReached ? (
              <>Daily AI limit reached · resets {formatTime(new Date(usage.resetsAt))}</>
            ) : (
              <>
                {usage.usedToday} / {usage.dailyLimit} AI uses today · {usage.provider === "gemini" ? "Gemini" : "Claude"}
              </>
            )
          ) : null}
          {" · "}
          <Link href="/settings/brand-voice" className="underline">
            Brand voice
          </Link>
        </span>
      </div>

      {undo && caption === undo.after ? (
        <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
          Caption updated by AI.{" "}
          <button
            type="button"
            className="font-medium underline"
            onClick={() => {
              onCaptionChange(undo.before);
              setUndo(null);
            }}
          >
            Undo
          </button>
        </p>
      ) : null}

      {/* Write with AI */}
      {writeOpen ? (
        <div className="mt-3 flex flex-col gap-3 border-t border-violet-200 pt-3 dark:border-violet-900">
          <div>
            <label htmlFor="ai-idea" className="text-xs font-medium">
              What&apos;s the post about?
            </label>
            <textarea
              id="ai-idea"
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="e.g. New autumn menu, 20% off this weekend"
              className="mt-1 w-full rounded-lg border border-neutral-300 bg-white p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </div>
          <fieldset>
            <legend className="text-xs font-medium">Tone</legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {TONES.map((t) => (
                <label
                  key={t.value}
                  className={`cursor-pointer rounded-full border px-3 py-1 text-xs has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue-500 ${
                    tone === t.value
                      ? "border-violet-600 bg-violet-600 text-white"
                      : "border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-900"
                  }`}
                >
                  <input type="radio" name="ai-tone" value={t.value} checked={tone === t.value} onChange={() => setTone(t.value)} className="sr-only" />
                  {t.label}
                </label>
              ))}
            </div>
          </fieldset>
          {photoCount > 0 ? (
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={usePhotos} onChange={(e) => setUsePhotos(e.target.checked)} />
              Let AI look at my {photoCount === 1 ? "photo" : `photos (first ${Math.min(photoCount, 4)})`}
            </label>
          ) : null}
          <div className="w-44">
            <Button type="button" onClick={writeCaptions} loading={busy === "captions"} disabled={disabled || (!idea.trim() && !(usePhotos && photoCount > 0))}>
              Write 3 captions
            </Button>
          </div>
          {!idea.trim() && !(usePhotos && photoCount > 0) ? <p className="text-xs text-neutral-500">Describe the post or add a photo first.</p> : null}
          {errorFor("captions")}

          {captions ? (
            <div className="flex flex-col gap-2">
              <ol className="flex flex-col gap-2">
                {captions.options.map((text, i) => (
                  <li key={i} className="rounded-lg border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
                    <p className="whitespace-pre-wrap">{text}</p>
                    <div className="mt-2 flex items-center justify-between text-xs text-neutral-500">
                      <span>{text.length} characters</span>
                      <button
                        type="button"
                        className="rounded-md bg-violet-600 px-3 py-1 font-medium text-white hover:bg-violet-700"
                        onClick={() => {
                          apply(text);
                          sendFeedback(workspaceId, captions.requestId, { appliedIndex: i });
                        }}
                      >
                        Use this
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
              <Rating
                value={captions.rating}
                onRate={(rating) => {
                  setCaptions({ ...captions, rating });
                  sendFeedback(workspaceId, captions.requestId, { rating });
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Hashtags */}
      {errorFor("hashtags")}
      {hashtags ? (
        <div className="mt-3 border-t border-violet-200 pt-3 dark:border-violet-900">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium">Suggested hashtags · click to add</p>
            <div className="flex gap-3 text-xs">
              {unusedHashtags.length > 0 ? (
                <button type="button" className="font-medium underline" onClick={() => addSuggestedTags(unusedHashtags.map((h) => h.tag))}>
                  Add all
                </button>
              ) : null}
              <button type="button" className="text-neutral-500 underline" onClick={() => setHashtags(null)}>
                Close
              </button>
            </div>
          </div>
          <ul className="mt-2 flex flex-wrap gap-2">
            {hashtags.tags.map((h) => {
              const added = captionHasTag(caption, h.tag);
              return (
                <li key={h.tag}>
                  <button
                    type="button"
                    disabled={added}
                    onClick={() => addSuggestedTags([h.tag])}
                    className="rounded-full border border-neutral-300 bg-white px-3 py-1 text-xs hover:border-violet-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
                    title={h.kind === "broad" ? "Broad: popular, for reach" : "Niche: specific, for the right audience"}
                  >
                    {added ? "✓ " : ""}#{h.tag} <span className="text-neutral-400">{h.kind}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Rewrite */}
      {errorFor("rewrite")}
      {rewrite ? (
        <div className="mt-3 border-t border-violet-200 pt-3 dark:border-violet-900">
          <p className="text-xs font-medium">Suggested rewrite</p>
          <p className="mt-2 whitespace-pre-wrap rounded-lg border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
            {diffWords(rewrite.before, rewrite.text).map((part, i) =>
              part.change === "same" ? (
                <span key={i}>{part.text}</span>
              ) : part.change === "removed" ? (
                <del key={i} className="bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300">
                  {part.text}
                </del>
              ) : (
                <ins key={i} className="bg-green-100 text-green-800 no-underline dark:bg-green-950 dark:text-green-300">
                  {part.text}
                </ins>
              ),
            )}
          </p>
          {caption !== rewrite.before ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">The caption changed since this was written; applying replaces it.</p> : null}
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              className="rounded-md bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-700"
              onClick={() => {
                apply(rewrite.text);
                sendFeedback(workspaceId, rewrite.requestId, { appliedIndex: 0 });
                setRewrite(null);
              }}
            >
              Apply
            </button>
            <button type="button" className="text-xs underline" onClick={() => setRewrite(null)}>
              Discard
            </button>
            <Rating
              value={rewrite.rating}
              onRate={(rating) => {
                setRewrite({ ...rewrite, rating });
                sendFeedback(workspaceId, rewrite.requestId, { rating });
              }}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ToolButton({
  children,
  onClick,
  disabled,
  busy,
  pressed,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      className={`h-8 rounded-lg border px-3 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
        pressed
          ? "border-violet-600 bg-violet-600 text-white"
          : "border-neutral-300 bg-white hover:border-violet-500 dark:border-neutral-700 dark:bg-neutral-900"
      }`}
    >
      {busy ? "Working…" : children}
    </button>
  );
}

function Rating({ value, onRate }: { value?: 1 | -1; onRate: (rating: 1 | -1) => void }) {
  return (
    <span className="ml-auto flex items-center gap-1 text-xs text-neutral-500">
      {value ? "Thanks for the feedback" : "Helpful?"}
      <button type="button" aria-label="Good suggestions" aria-pressed={value === 1} onClick={() => onRate(1)} className={`rounded px-1 ${value === 1 ? "bg-green-100 dark:bg-green-950" : ""}`}>
        👍
      </button>
      <button type="button" aria-label="Bad suggestions" aria-pressed={value === -1} onClick={() => onRate(-1)} className={`rounded px-1 ${value === -1 ? "bg-red-100 dark:bg-red-950" : ""}`}>
        👎
      </button>
    </span>
  );
}
