import type { PlatformCapabilities } from "../types.js";
import { X_MAX_WEIGHT, X_THREAD_MAX_POSTS } from "./text.js";

// From X's create-post, media upload and counting-characters docs (checked 2026-10-29, API v2):
// https://docs.x.com/x-api/posts/create-post
// https://docs.x.com/x-api/media/quickstart/media-upload-chunked
// https://docs.x.com/fundamentals/counting-characters
export const xCapabilities: PlatformCapabilities = {
  platform: "X",
  displayName: "X",
  // One post is 280 weighted characters (text.ts); longer text is published as a thread, so this is
  // only an outer bound. validatePost checks each post of the thread.
  captionMaxLength: X_MAX_WEIGHT * X_THREAD_MAX_POSTS,
  // Photos as uploaded by the simple upload endpoint (5 MB). Our storage delivers JPEGs.
  image: { formats: ["image/jpeg", "image/png", "image/webp"], maxBytes: 5 * 1024 * 1024, minAspectRatio: 0, maxAspectRatio: Infinity },
  // X accepts videos from 0.5 seconds to 20 minutes (longer for Premium). The size cap is ours: big
  // uploads are slow, and X's own 8 GB limit is far above what people schedule.
  video: { formats: ["video/mp4"], maxBytes: 512 * 1024 * 1024, minSeconds: 0.5, maxSeconds: 20 * 60 },
  // "A Post may include up to 4 photos, 1 animated GIF, or 1 video."
  carouselMaxItems: 4,
  // Self-serve API apps get 100 posts per user per 15 minutes; there's no daily per-account limit to plan around.
  supportedAccountTypes: ["USER"],
};
