import type { PlatformCapabilities } from "../types.js";
import { BLUESKY_MAX_GRAPHEMES, BLUESKY_THREAD_MAX_POSTS } from "./text.js";

// From the app.bsky.feed.post and app.bsky.embed.images lexicons (checked 2026-10-29).
export const blueskyCapabilities: PlatformCapabilities = {
  platform: "BLUESKY",
  displayName: "Bluesky",
  // One post is 300 graphemes (text.ts); longer text is published as a thread, so this is only an outer
  // bound. validatePost checks each post of the thread.
  captionMaxLength: BLUESKY_MAX_GRAPHEMES * BLUESKY_THREAD_MAX_POSTS,
  // "May be up to 2 MB" per image. Our storage delivers JPEGs.
  image: { formats: ["image/jpeg", "image/png", "image/webp"], maxBytes: 2_000_000, minAspectRatio: 0, maxAspectRatio: Infinity },
  // Up to 4 images per post. Videos go through Bluesky's separate video service and aren't supported here yet.
  carouselMaxItems: 4,
  supportedAccountTypes: ["USER"],
};
