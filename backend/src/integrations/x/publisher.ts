import type { PostFormat } from "../../generated/prisma/enums.js";
import type { FormatMedia, PublishContext, PublishMedia, PublishRequest, PublishResult } from "../types.js";
import { PlatformApiError } from "../types.js";
import { xCapabilities as caps } from "./capabilities.js";
import * as x from "./client.js";
import { splitThread, weightedLength, X_MAX_WEIGHT, X_THREAD_MAX_POSTS } from "./text.js";

// Publishing to X. The text becomes one post or a thread (text.ts); photos or the video go on the first
// post, and each further post replies to the one before it.
//  - photos: one upload request each (POST /2/media/upload)
//  - video:  initialize, append ~4 MB chunks (read from Cloudinary by byte range, so the whole file is
//            never in memory), finalize, then wait until X has processed it
//  - posts:  POST /2/tweets, in order, each with reply.in_reply_to_tweet_id set to the previous post
//
// Every media ID and post ID is saved (ctx.saveState) as soon as X returns it, so a retry resumes where
// it stopped, even halfway through a thread. X can't be asked afterwards whether a post went through
// without paying for reads, so a marker is saved just before each post is created: if a retry finds the
// marker without a result, we stop rather than risk posting twice.

const CHUNK_BYTES = 4 * 1024 * 1024;
const MIN_PROCESSING_POLL_MS = 5_000;
const MAX_IMAGE_BYTES = caps.image!.maxBytes;

interface XPublishState {
  /** Uploaded photo IDs, in order, or the video's ID. */
  mediaIds?: string[];
  video?: { id: string; appended: number; finalized?: boolean; ready?: boolean };
  /** IDs of the thread's posts created so far, in order. */
  postIds?: string[];
  /** Index of the post being created; set just before the call (see above). */
  creating?: number;
}

export function chooseFormat(media: FormatMedia[]): PostFormat | null {
  if (media.length === 0) return "TEXT";
  const videos = media.filter((m) => m.type === "VIDEO");
  if (videos.length === 0) return media.length === 1 ? "IMAGE" : "CAROUSEL";
  // A post can have up to 4 photos or 1 video, not a mix.
  return media.length === 1 ? "VIDEO" : null;
}

export function validatePost(req: PublishRequest): string[] {
  const problems: string[] = [];
  const posts = splitThread(req.caption);
  if (req.media.length === 0 && posts.length === 0) problems.push("Write something or add a photo or video.");
  if (posts.length > X_THREAD_MAX_POSTS) {
    problems.push(`This text makes a thread of ${posts.length} posts on X; threads here can have at most ${X_THREAD_MAX_POSTS}. Shorten it.`);
  } else {
    // Only a single word longer than a post could still be too long after splitting.
    const tooLong = posts.findIndex((p) => weightedLength(p) > X_MAX_WEIGHT);
    if (tooLong >= 0) problems.push(`Post ${tooLong + 1} of the thread is longer than X's ${X_MAX_WEIGHT} characters.`);
  }

  const videos = req.media.filter((m) => m.type === "VIDEO");
  if (videos.length > 0 && req.media.length > 1) problems.push("X posts can have up to 4 photos or 1 video, not both.");
  else if (req.media.length > caps.carouselMaxItems!) problems.push(`X posts can have at most ${caps.carouselMaxItems} photos.`);
  for (const v of videos) {
    if (v.format !== "mp4") problems.push("X videos must be MP4.");
    if (v.bytes > caps.video!.maxBytes) problems.push("The video is larger than 512 MB.");
    if (v.durationSec != null && (v.durationSec < caps.video!.minSeconds || v.durationSec > caps.video!.maxSeconds)) {
      problems.push("X videos must be between 0.5 seconds and 20 minutes long.");
    }
  }
  return problems;
}

export async function publish(ctx: PublishContext): Promise<PublishResult> {
  const state = { ...(ctx.state as XPublishState) };
  const save = async (patch: XPublishState) => {
    Object.assign(state, patch);
    await ctx.saveState({ ...state });
  };
  const { accessToken: token, request } = ctx;
  const parts = splitThread(request.caption);
  // A post with only media has no text.
  const posts = parts.length > 0 ? parts : [""];
  const postIds = [...(state.postIds ?? [])];

  if (postIds.length >= posts.length) return published(postIds[0]!);
  if (state.creating !== undefined) {
    // Cleared so the user's own Retry (after checking their profile) carries on.
    const index = state.creating;
    await save({ creating: undefined });
    throw unconfirmed(index, posts.length);
  }

  // Media goes on the first post only, so it's only needed until that post exists.
  let mediaIds: string[] = [];
  if (postIds.length === 0 && request.media.length > 0) {
    if (request.format === "VIDEO") {
      const ready = await uploadVideo(ctx, state, save);
      if (!ready.done) return { kind: "waiting", retryAfterMs: ready.retryAfterMs };
      mediaIds = [state.video!.id];
    } else {
      mediaIds = [...(state.mediaIds ?? [])];
      for (let i = mediaIds.length; i < request.media.length; i++) {
        mediaIds.push(await x.uploadImage(token, await download(request.media[i]!), "image/jpeg"));
        await save({ mediaIds });
      }
    }
  }

  for (let i = postIds.length; i < posts.length; i++) {
    await save({ creating: i });
    let id: string;
    try {
      id = await x.createPost(token, { text: posts[i]!, mediaIds: i === 0 ? mediaIds : undefined, replyTo: postIds[i - 1] });
    } catch (err) {
      // X answered, so nothing was created and trying again is safe. If it couldn't be reached or
      // failed on its side we can't know: the marker stays, and the next attempt stops.
      if (err instanceof PlatformApiError && err.code !== "UNAVAILABLE") await save({ creating: undefined });
      throw i === 0 ? err : partOfThread(err, i, posts.length);
    }
    postIds.push(id);
    await save({ postIds, creating: undefined });
  }
  return published(postIds[0]!);
}

/** Uploads the video chunk by chunk, finalizes it, and reports whether X has finished processing it. */
async function uploadVideo(
  ctx: PublishContext,
  state: XPublishState,
  save: (s: XPublishState) => Promise<void>,
): Promise<{ done: true } | { done: false; retryAfterMs: number }> {
  const { accessToken: token } = ctx;
  const video = ctx.request.media[0]!;

  if (!state.video) {
    const id = await x.initializeUpload(token, { totalBytes: video.bytes, mediaType: "video/mp4" });
    await save({ video: { id, appended: 0 } });
  }
  const v = state.video!;
  if (v.ready) return { done: true };

  let info: x.ProcessingInfo;
  if (!v.finalized) {
    const chunks = Math.ceil(video.bytes / CHUNK_BYTES);
    for (let i = v.appended; i < chunks; i++) {
      const first = i * CHUNK_BYTES;
      const last = Math.min(first + CHUNK_BYTES, video.bytes) - 1;
      await x.appendChunk(token, v.id, i, await downloadRange(video, first, last));
      await save({ video: { ...v, appended: i + 1 } });
    }
    info = await x.finalizeUpload(token, v.id);
    await save({ video: { ...state.video!, finalized: true } });
  } else {
    info = await x.getUploadStatus(token, v.id);
  }

  if (info.state === "failed") {
    throw new PlatformApiError("X", "MEDIA_REJECTED", `X couldn't process the video${info.error ? `: ${info.error}` : ""}`);
  }
  // No processing_info means there's nothing left to process.
  if (info.state === undefined || info.state === "succeeded") {
    await save({ video: { ...state.video!, ready: true } });
    return { done: true };
  }
  return { done: false, retryAfterMs: Math.max((info.checkAfterSecs ?? 5) * 1000, MIN_PROCESSING_POLL_MS) };
}

const published = (postId: string): PublishResult => ({ kind: "published", externalPostId: postId, permalink: x.postUrl(postId) });

/** A failure partway through a thread: the earlier posts are already live, and a retry carries on from here. */
function partOfThread(err: unknown, index: number, total: number): unknown {
  if (!(err instanceof PlatformApiError)) return err;
  const posted = `${index} of ${total} posts in the thread ${index === 1 ? "is" : "are"} on X`;
  return new PlatformApiError(err.platform, err.code, `${posted}; post ${index + 1} failed: ${err.message}`, err.details);
}

/** A photo, as the processed JPEG from our storage. */
async function download(media: PublishMedia): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetchMedia(media.url, {});
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new PlatformApiError("X", "MEDIA_REJECTED", "The photo is larger than X's 5 MB limit.");
  return bytes;
}

/** One chunk of a video, read by byte range so large videos are never held in memory whole. */
async function downloadRange(media: PublishMedia, firstByte: number, lastByte: number): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetchMedia(media.url, { Range: `bytes=${firstByte}-${lastByte}` });
  let bytes = new Uint8Array(await res.arrayBuffer());
  // A server that ignores Range sends the whole file.
  if (res.status === 200) bytes = bytes.subarray(firstByte, lastByte + 1);
  if (bytes.length !== lastByte - firstByte + 1) throw new PlatformApiError("X", "UNAVAILABLE", "Couldn't read the video from storage");
  return bytes;
}

async function fetchMedia(url: string, headers: Record<string, string>): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new PlatformApiError("X", "UNAVAILABLE", "Couldn't read the media from storage");
  }
  if (!res.ok) throw new PlatformApiError("X", "UNAVAILABLE", `Couldn't read the media from storage (HTTP ${res.status})`);
  return res;
}

/** Not retried automatically: a person should check their profile first. */
function unconfirmed(index: number, total: number) {
  const which = total > 1 ? `post ${index + 1} of this thread` : "this post";
  return new PlatformApiError("X", "BAD_REQUEST", `Couldn't confirm whether X published ${which}. Check your X profile; if it isn't there, retry.`);
}
