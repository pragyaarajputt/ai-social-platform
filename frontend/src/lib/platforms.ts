import { INSTAGRAM, instagramFormat, instagramProblems } from "./instagramRules";
import type { MediaItem } from "./posts";
import type { SocialPlatform } from "./workspaces";

// Per-platform rules and labels for the composer and post pages. Mirrors the backend adapters in
// backend/src/integrations/*; the server checks everything again.

export type PostFormat = "TEXT" | "IMAGE" | "CAROUSEL" | "REEL" | "VIDEO";

export const PLATFORM_NAMES: Record<SocialPlatform, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  THREADS: "Threads",
  LINKEDIN: "LinkedIn",
  X: "X",
  YOUTUBE: "YouTube",
  TIKTOK: "TikTok",
};
export const platformName = (p: SocialPlatform) => PLATFORM_NAMES[p] ?? p;

/** "Carousel" on Instagram is a "Multi-photo post" on Facebook. */
export function formatLabel(format: PostFormat, platform: SocialPlatform = "INSTAGRAM"): string {
  switch (format) {
    case "TEXT":
      return "Text post";
    case "IMAGE":
      return platform === "FACEBOOK" ? "Photo" : "Single image";
    case "CAROUSEL":
      return platform === "FACEBOOK" ? "Multi-photo post" : "Carousel";
    case "REEL":
      return "Reel";
    case "VIDEO":
      return "Video";
  }
}

export const CAPTION_MAX: Partial<Record<SocialPlatform, number>> = { INSTAGRAM: INSTAGRAM.captionMax, FACEBOOK: 63_206 };

export const FACEBOOK = {
  captionMax: 63_206,
  photosMax: 10,
  reel: { minSeconds: 3, maxSeconds: 90, maxAspect: 0.6, minWidth: 540 },
};

type FormatMedia = Pick<MediaItem, "type" | "width" | "height" | "durationSec">;

/** Vertical, 3–90 s videos become Reels on Facebook; other videos are regular video posts. */
export function isFacebookReel(m: FormatMedia): boolean {
  const r = FACEBOOK.reel;
  return m.width > 0 && m.height > 0 && m.width / m.height <= r.maxAspect && m.width >= r.minWidth && m.durationSec != null && m.durationSec >= r.minSeconds && m.durationSec <= r.maxSeconds;
}

export function facebookFormat(media: FormatMedia[]): PostFormat | null {
  if (media.length === 0) return "TEXT";
  const videos = media.filter((m) => m.type === "VIDEO");
  if (videos.length === 0) return media.length === 1 ? "IMAGE" : "CAROUSEL";
  if (media.length > 1) return null;
  return isFacebookReel(videos[0]!) ? "REEL" : "VIDEO";
}

export function facebookProblems(caption: string, media: MediaItem[]): string[] {
  const problems: string[] = [];
  if (caption.length > FACEBOOK.captionMax) problems.push(`Text is ${caption.length.toLocaleString()} characters; Facebook allows ${FACEBOOK.captionMax.toLocaleString()}.`);
  const videos = media.filter((m) => m.type === "VIDEO");
  if (videos.length > 0 && media.length > 1) problems.push("Facebook posts can have several photos or one video, not both.");
  if (media.length === 0 && !caption.trim()) problems.push("Write something or add a photo or video.");
  if (media.length > FACEBOOK.photosMax) problems.push(`Facebook posts here can have at most ${FACEBOOK.photosMax} photos.`);
  return problems;
}

export function formatFor(platform: SocialPlatform, media: MediaItem[]): PostFormat | null {
  return platform === "FACEBOOK" ? facebookFormat(media) : instagramFormat(media);
}

export function problemsFor(platform: SocialPlatform, caption: string, media: MediaItem[]): string[] {
  return platform === "FACEBOOK" ? facebookProblems(caption, media) : instagramProblems(caption, media);
}
