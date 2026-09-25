import { api, ApiError } from "./api";
import { countHashtags, INSTAGRAM } from "./instagramRules";

// AI writing tools. Everything here returns suggestions; the composer only changes the caption
// when the user applies one.

export type Tone = "professional" | "casual" | "funny" | "genz" | "motivational";
export const TONES: { value: Tone; label: string }[] = [
  { value: "professional", label: "Professional" },
  { value: "casual", label: "Casual" },
  { value: "funny", label: "Funny" },
  { value: "genz", label: "Gen Z" },
  { value: "motivational", label: "Motivational" },
];

export type RewriteAction = "improve" | "engaging" | "shorter" | "longer" | "grammar" | "tone" | "instagram";
export const REWRITE_ACTIONS: { value: RewriteAction; label: string }[] = [
  { value: "improve", label: "Improve" },
  { value: "engaging", label: "More engaging" },
  { value: "shorter", label: "Shorter" },
  { value: "longer", label: "Longer" },
  { value: "grammar", label: "Fix grammar" },
  { value: "tone", label: "Change tone" },
  { value: "instagram", label: "Optimize for Instagram" },
];

export interface HashtagSuggestion {
  tag: string;
  kind: "broad" | "niche";
}

export interface AiUsage {
  configured: boolean;
  model: string;
  usedToday: number;
  dailyLimit: number;
  resetsAt: string;
}

export interface BrandVoice {
  tone: string | null;
  audience: string | null;
  dos: string | null;
  donts: string | null;
  samplePost: string | null;
  updatedAt?: string;
}

const base = (workspaceId: string) => `/workspaces/${workspaceId}`;

export function generateCaptions(workspaceId: string, input: { idea: string; mediaIds: string[]; tone?: Tone }) {
  return api<{ requestId: string; captions: string[] }>(`${base(workspaceId)}/ai/captions`, { method: "POST", body: input });
}

export function suggestHashtags(workspaceId: string, input: { caption: string; mediaIds: string[] }) {
  return api<{ requestId: string; hashtags: HashtagSuggestion[] }>(`${base(workspaceId)}/ai/hashtags`, { method: "POST", body: input });
}

export function rewriteCaption(workspaceId: string, input: { text: string; action: RewriteAction; tone?: Tone }) {
  return api<{ requestId: string; text: string }>(`${base(workspaceId)}/ai/rewrite`, { method: "POST", body: input });
}

/**
 * Which suggestion was used (for hashtags, 0 means "some were added") and/or a thumbs up (1) or down (-1).
 * Best effort: a failure here shouldn't bother the user.
 */
export function sendFeedback(workspaceId: string, requestId: string, feedback: { appliedIndex?: number; rating?: 1 | -1 }) {
  return api<void>(`${base(workspaceId)}/ai/requests/${requestId}/feedback`, { method: "POST", body: feedback }).catch(() => undefined);
}

export function getAiUsage(workspaceId: string) {
  return api<AiUsage>(`${base(workspaceId)}/ai/usage`);
}

export async function getBrandVoice(workspaceId: string) {
  return (await api<{ brandVoice: BrandVoice | null }>(`${base(workspaceId)}/brand-voice`)).brandVoice;
}

export async function saveBrandVoice(workspaceId: string, voice: Omit<BrandVoice, "updatedAt">) {
  return (await api<{ brandVoice: BrandVoice | null }>(`${base(workspaceId)}/brand-voice`, { method: "PUT", body: voice })).brandVoice;
}

/** A friendly message for an AI error. The server's messages are already written for users. */
export function aiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.fieldErrors.length) return err.fieldErrors[0]!.message;
    if (err.code === "TOO_MANY_REQUESTS" || err.code.startsWith("AI_") || err.code === "NOT_CONFIGURED" || err.code === "HASHTAG_LIMIT") return err.message;
    if (err.code === "NETWORK_ERROR") return err.message;
  }
  return "AI couldn't finish that. Try again.";
}

const hasTag = (caption: string, tag: string) =>
  new RegExp(`(^|\\s)#${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(caption);

/**
 * Appends hashtags to the end of a caption, skipping ones it already has (in any letter case) and
 * stopping at Instagram's 30-hashtag limit. Hashtags go on their own line after the text.
 */
export function addHashtags(caption: string, tags: string[]): { caption: string; added: string[]; skipped: string[] } {
  let room = INSTAGRAM.hashtagMax - countHashtags(caption);
  const added: string[] = [];
  const skipped: string[] = [];
  for (const tag of tags) {
    const already = hasTag(caption, tag) || added.some((a) => a.toLowerCase() === tag.toLowerCase());
    if (already || room <= 0) {
      skipped.push(tag);
      continue;
    }
    added.push(tag);
    room -= 1;
  }
  if (added.length === 0) return { caption, added, skipped };

  const addition = added.map((t) => `#${t}`).join(" ");
  const trimmed = caption.trimEnd();
  // Continue an existing trailing line of hashtags; otherwise start a new paragraph.
  const lastLine = trimmed.split("\n").at(-1) ?? "";
  const endsWithTags = /^(\s*#[\p{L}\p{N}_]+)+\s*$/u.test(lastLine);
  const separator = trimmed === "" ? "" : endsWithTags ? " " : "\n\n";
  return { caption: `${trimmed}${separator}${addition}`, added, skipped };
}

/** Whether a hashtag is already in the caption, for showing suggestion chips as added. */
export const captionHasTag = hasTag;

export type DiffPart = { text: string; change: "same" | "added" | "removed" };

/**
 * A word-level before/after comparison for the rewrite preview (longest common subsequence over
 * words and whitespace). Captions are short, so the quadratic table is fine; very long texts fall
 * back to "all removed, all added".
 */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = before.split(/(\s+)/).filter(Boolean);
  const b = after.split(/(\s+)/).filter(Boolean);
  if (a.length * b.length > 400_000) {
    return [
      { text: before, change: "removed" },
      { text: after, change: "added" },
    ];
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const parts: DiffPart[] = [];
  const push = (text: string, change: DiffPart["change"]) => {
    const last = parts.at(-1);
    if (last?.change === change) last.text += text;
    else parts.push({ text, change });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(a[i]!, "same");
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push(a[i++]!, "removed");
    else push(b[j++]!, "added");
  }
  while (i < a.length) push(a[i++]!, "removed");
  while (j < b.length) push(b[j++]!, "added");
  return parts;
}
