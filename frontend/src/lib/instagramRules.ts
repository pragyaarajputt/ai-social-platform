import type { MediaItem } from "./posts";

// Mirrors backend/src/integrations/instagram/{capabilities,publisher}.ts so the composer can show
// problems as you type. The server checks everything again.

export const INSTAGRAM = {
  captionMax: 2200,
  hashtagMax: 30,
  mentionMax: 20,
  carouselMax: 10,
  minAspect: 4 / 5,
  maxAspect: 1.91,
  minWidth: 320,
  videoMaxBytes: 300 * 1024 * 1024,
  videoMinSec: 3,
  videoMaxSec: 15 * 60,
};

export type InstagramFormat = "IMAGE" | "CAROUSEL" | "REEL";

export function instagramFormat(media: Pick<MediaItem, "type">[]): InstagramFormat | null {
  if (media.length === 0) return null;
  if (media.length > 1) return "CAROUSEL";
  return media[0]!.type === "VIDEO" ? "REEL" : "IMAGE";
}


export function countHashtags(text: string) {
  return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

export function countMentions(text: string) {
  return (text.match(/(^|\s)@[\w.]+/g) ?? []).length;
}

export function instagramProblems(caption: string, media: MediaItem[]): string[] {
  const problems: string[] = [];
  if (caption.length > INSTAGRAM.captionMax) problems.push(`Caption is ${caption.length} characters; the limit is ${INSTAGRAM.captionMax}.`);
  if (countHashtags(caption) > INSTAGRAM.hashtagMax) problems.push(`Use at most ${INSTAGRAM.hashtagMax} hashtags.`);
  if (countMentions(caption) > INSTAGRAM.mentionMax) problems.push(`Use at most ${INSTAGRAM.mentionMax} @mentions.`);
  if (media.length === 0) problems.push("Add at least one photo or video.");
  if (media.length > INSTAGRAM.carouselMax) problems.push(`A carousel can have at most ${INSTAGRAM.carouselMax} items.`);

  media.forEach((m, i) => {
    const label = media.length > 1 ? `Item ${i + 1}` : m.type === "VIDEO" ? "The video" : "The image";
    if (m.type === "IMAGE") {
      const ratio = m.width / m.height;
      if (ratio < INSTAGRAM.minAspect - 0.005 || ratio > INSTAGRAM.maxAspect + 0.005) {
        problems.push(`${label} is ${m.width}×${m.height}. Instagram needs an aspect ratio between 4:5 (portrait) and 1.91:1 (landscape).`);
      }
      if (m.width < INSTAGRAM.minWidth) problems.push(`${label} is only ${m.width} px wide; Instagram needs at least ${INSTAGRAM.minWidth} px.`);
    } else {
      if (m.bytes > INSTAGRAM.videoMaxBytes) problems.push(`${label} is larger than 300 MB.`);
      if (m.durationSec != null && (m.durationSec < INSTAGRAM.videoMinSec || m.durationSec > INSTAGRAM.videoMaxSec)) {
        problems.push(`${label} is ${Math.round(m.durationSec)} s long; Instagram needs 3 s to 15 minutes.`);
      }
    }
  });
  return problems;
}
