import { INSTAGRAM, instagramFormat, instagramProblems } from "./instagramRules";
import type { MediaItem } from "./posts";
import type { SocialAccount, SocialPlatform } from "./workspaces";
import { BLUESKY_MAX_BYTES, BLUESKY_MAX_GRAPHEMES, BLUESKY_THREAD_MAX_POSTS, byteLength, graphemeLength, splitThread as splitBlueskyThread } from "./blueskyThread";
import { splitThread, weightedLength, X_MAX_WEIGHT, X_THREAD_MAX_POSTS } from "./xThread";

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
  BLUESKY: "Bluesky",
};
export const platformName = (p: SocialPlatform) => PLATFORM_NAMES[p] ?? p;

/**
 * How an account is named everywhere: "@handle" on Instagram, X and Bluesky, the Page name on Facebook, the person's
 * name on LinkedIn (LinkedIn profiles have no handle we can read).
 */
export function accountLabel(account: Pick<SocialAccount, "platform" | "username" | "name">): string {
  if (account.platform === "FACEBOOK") return account.name ?? account.username ?? "a Facebook Page";
  if (account.platform === "LINKEDIN") return account.name ?? "a LinkedIn profile";
  return account.username ? `@${account.username}` : (account.name ?? "an account");
}

/** "Carousel" on Instagram is a "Multi-photo post" on Facebook and X and a "Multi-image post" on LinkedIn. */
export function formatLabel(format: PostFormat, platform: SocialPlatform = "INSTAGRAM"): string {
  switch (format) {
    case "TEXT":
      return "Text post";
    case "IMAGE":
      return platform === "INSTAGRAM" ? "Single image" : "Photo";
    case "CAROUSEL":
      return platform === "FACEBOOK" || platform === "X" || platform === "BLUESKY" ? "Multi-photo post" : platform === "LINKEDIN" ? "Multi-image post" : "Carousel";
    case "REEL":
      return "Reel";
    case "VIDEO":
      return "Video";
  }
}

export const CAPTION_MAX: Partial<Record<SocialPlatform, number>> = { INSTAGRAM: INSTAGRAM.captionMax, FACEBOOK: 63_206, LINKEDIN: 3000 };

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

/** LinkedIn personal profiles. Mirrors backend/src/integrations/linkedin. */
export const LINKEDIN = {
  captionMax: 3000,
  photosMax: 10,
  video: { formats: ["mp4"], minSeconds: 3, maxSeconds: 30 * 60, maxBytes: 500 * 1024 * 1024, minBytes: 75 * 1024 },
};

export function linkedinFormat(media: FormatMedia[]): PostFormat | null {
  if (media.length === 0) return "TEXT";
  const videos = media.filter((m) => m.type === "VIDEO");
  if (videos.length === 0) return media.length === 1 ? "IMAGE" : "CAROUSEL";
  return media.length === 1 ? "VIDEO" : null;
}

export function linkedinProblems(caption: string, media: MediaItem[]): string[] {
  const problems: string[] = [];
  const v = LINKEDIN.video;
  if (caption.length > LINKEDIN.captionMax) problems.push(`Text is ${caption.length.toLocaleString()} characters; LinkedIn allows ${LINKEDIN.captionMax.toLocaleString()}.`);
  if (media.length === 0 && !caption.trim()) problems.push("Write something or add a photo or video.");
  const videos = media.filter((m) => m.type === "VIDEO");
  if (videos.length > 0 && media.length > 1) problems.push("LinkedIn posts can have several photos or one video, not both.");
  if (media.length > LINKEDIN.photosMax) problems.push(`LinkedIn posts here can have at most ${LINKEDIN.photosMax} photos.`);
  for (const m of videos) {
    if (!v.formats.includes(m.format)) problems.push("LinkedIn videos must be MP4.");
    if (m.bytes > v.maxBytes) problems.push("The video is larger than 500 MB.");
    if (m.bytes < v.minBytes) problems.push("The video is too small for LinkedIn (at least 75 KB).");
    if (m.durationSec != null && (m.durationSec < v.minSeconds || m.durationSec > v.maxSeconds)) {
      problems.push("LinkedIn videos must be between 3 seconds and 30 minutes long.");
    }
  }
  return problems;
}

/** X accounts. Mirrors backend/src/integrations/x. Text longer than one post is published as a thread. */
export const X = {
  photosMax: 4,
  video: { formats: ["mp4"], minSeconds: 0.5, maxSeconds: 20 * 60, maxBytes: 512 * 1024 * 1024 },
};

export function xFormat(media: FormatMedia[]): PostFormat | null {
  if (media.length === 0) return "TEXT";
  const videos = media.filter((m) => m.type === "VIDEO");
  if (videos.length === 0) return media.length === 1 ? "IMAGE" : "CAROUSEL";
  return media.length === 1 ? "VIDEO" : null;
}

export function xProblems(caption: string, media: MediaItem[]): string[] {
  const problems: string[] = [];
  const v = X.video;
  const posts = splitThread(caption);
  if (media.length === 0 && posts.length === 0) problems.push("Write something or add a photo or video.");
  if (posts.length > X_THREAD_MAX_POSTS) {
    problems.push(`This text makes a thread of ${posts.length} posts on X; threads here can have at most ${X_THREAD_MAX_POSTS}. Shorten it.`);
  } else {
    const tooLong = posts.findIndex((p) => weightedLength(p) > X_MAX_WEIGHT);
    if (tooLong >= 0) problems.push(`Post ${tooLong + 1} of the thread is longer than X's ${X_MAX_WEIGHT} characters.`);
  }
  const videos = media.filter((m) => m.type === "VIDEO");
  if (videos.length > 0 && media.length > 1) problems.push("X posts can have up to 4 photos or 1 video, not both.");
  else if (media.length > X.photosMax) problems.push(`X posts can have at most ${X.photosMax} photos.`);
  for (const m of videos) {
    if (!v.formats.includes(m.format)) problems.push("X videos must be MP4.");
    if (m.bytes > v.maxBytes) problems.push("The video is larger than 512 MB.");
    if (m.durationSec != null && (m.durationSec < v.minSeconds || m.durationSec > v.maxSeconds)) {
      problems.push("X videos must be between 0.5 seconds and 20 minutes long.");
    }
  }
  return problems;
}

/** Bluesky accounts. Mirrors backend/src/integrations/bluesky. Text longer than one post is published as a thread. */
export const BLUESKY = { photosMax: 4 };

export function blueskyFormat(media: FormatMedia[]): PostFormat | null {
  if (media.length === 0) return "TEXT";
  if (media.some((m) => m.type === "VIDEO")) return null;
  return media.length === 1 ? "IMAGE" : "CAROUSEL";
}

export function blueskyProblems(caption: string, media: MediaItem[]): string[] {
  const problems: string[] = [];
  const posts = splitBlueskyThread(caption);
  if (media.length === 0 && posts.length === 0) problems.push("Write something or add a photo.");
  if (posts.length > BLUESKY_THREAD_MAX_POSTS) {
    problems.push(`This text makes a thread of ${posts.length} posts on Bluesky; threads here can have at most ${BLUESKY_THREAD_MAX_POSTS}. Shorten it.`);
  } else {
    const tooLong = posts.findIndex((p) => graphemeLength(p) > BLUESKY_MAX_GRAPHEMES || byteLength(p) > BLUESKY_MAX_BYTES);
    if (tooLong >= 0) problems.push(`Post ${tooLong + 1} of the thread is longer than Bluesky allows.`);
  }
  if (media.some((m) => m.type === "VIDEO")) problems.push("Videos can't be posted to Bluesky from PostDrip yet. Use photos, or remove Bluesky for this post.");
  else if (media.length > BLUESKY.photosMax) problems.push(`Bluesky posts can have at most ${BLUESKY.photosMax} photos.`);
  return problems;
}

export function formatFor(platform: SocialPlatform, media: MediaItem[]): PostFormat | null {
  if (platform === "FACEBOOK") return facebookFormat(media);
  if (platform === "LINKEDIN") return linkedinFormat(media);
  if (platform === "X") return xFormat(media);
  if (platform === "BLUESKY") return blueskyFormat(media);
  return instagramFormat(media);
}

export function problemsFor(platform: SocialPlatform, caption: string, media: MediaItem[]): string[] {
  if (platform === "FACEBOOK") return facebookProblems(caption, media);
  if (platform === "LINKEDIN") return linkedinProblems(caption, media);
  if (platform === "X") return xProblems(caption, media);
  if (platform === "BLUESKY") return blueskyProblems(caption, media);
  return instagramProblems(caption, media);
}
