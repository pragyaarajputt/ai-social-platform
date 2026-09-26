import type { PlatformCapabilities } from "../types.js";

// From Meta's Pages API and Video API docs (checked 2026-09-26):
// https://developers.facebook.com/docs/pages-api/posts
// https://developers.facebook.com/docs/video-api/guides/reels-publishing
export const facebookCapabilities: PlatformCapabilities = {
  platform: "FACEBOOK",
  displayName: "Facebook",
  // Facebook's post text limit.
  captionMaxLength: 63_206,
  image: { formats: ["image/jpeg", "image/png"], maxBytes: 10 * 1024 * 1024, minAspectRatio: 0, maxAspectRatio: Infinity },
  video: { formats: ["video/mp4", "video/quicktime"], maxBytes: 1024 * 1024 * 1024, minSeconds: 1, maxSeconds: 240 * 60 },
  // Our composer's limit; Facebook accepts more photos in one post.
  carouselMaxItems: 10,
  supportedAccountTypes: ["PAGE"],
};

/**
 * Reels: vertical (9:16), 3 to 90 seconds, at least 540 × 960. Other videos are posted as regular videos.
 * Facebook allows 30 API-published Reels per Page per rolling 24 hours; beyond that it returns a rate-limit
 * error, which the publish queue retries with backoff.
 */
export const REEL = { minSeconds: 3, maxSeconds: 90, maxAspectRatio: 0.6, minWidth: 540 };
