import type { PlatformCapabilities } from "../types.js";

// From Meta's content publishing docs (checked 2026-09-25):
// https://developers.facebook.com/docs/instagram-platform/content-publishing
// https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
export const instagramCapabilities: PlatformCapabilities = {
  platform: "INSTAGRAM",
  displayName: "Instagram",
  captionMaxLength: 2200,
  hashtagMax: 30,
  mentionMax: 20,
  image: { formats: ["image/jpeg"], maxBytes: 8 * 1024 * 1024, minAspectRatio: 4 / 5, maxAspectRatio: 1.91 },
  video: { formats: ["video/mp4", "video/quicktime"], maxBytes: 300 * 1024 * 1024, minSeconds: 3, maxSeconds: 15 * 60 },
  carouselMaxItems: 10,
  publishLimitPer24h: 100,
  // Values of the `account_type` field. Personal accounts can't use the API at all.
  supportedAccountTypes: ["BUSINESS", "MEDIA_CREATOR"],
};
