import type { PlatformCapabilities } from "../types.js";

// From LinkedIn's Posts, Images, Videos and MultiImage API docs (checked 2026-09-29, version 202609):
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
export const linkedinCapabilities: PlatformCapabilities = {
  platform: "LINKEDIN",
  displayName: "LinkedIn",
  // LinkedIn's post text limit.
  captionMaxLength: 3000,
  // JPG, GIF and PNG, under 36,152,320 pixels. No aspect ratio limits.
  image: { formats: ["image/jpeg", "image/png", "image/gif"], maxBytes: 10 * 1024 * 1024, minAspectRatio: 0, maxAspectRatio: Infinity },
  // Feed videos: MP4, 3 seconds to 30 minutes, 75 KB to 500 MB.
  video: { formats: ["video/mp4"], maxBytes: 500 * 1024 * 1024, minSeconds: 3, maxSeconds: 30 * 60 },
  // Our composer's limit; LinkedIn accepts 2 to 20 photos in one post.
  carouselMaxItems: 10,
  // Personal profiles only: posting as a Company Page needs LinkedIn's Community Management API.
  supportedAccountTypes: ["PERSON"],
};

export const MIN_VIDEO_BYTES = 75 * 1024;
