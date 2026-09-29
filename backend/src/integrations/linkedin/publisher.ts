import type { PostFormat } from "../../generated/prisma/enums.js";
import type { FormatMedia, PublishContext, PublishMedia, PublishRequest, PublishResult } from "../types.js";
import { PlatformApiError } from "../types.js";
import { linkedinCapabilities as caps, MIN_VIDEO_BYTES } from "./capabilities.js";
import * as li from "./client.js";

// Publishing to a member's LinkedIn feed, by format:
//  - TEXT:      POST /rest/posts
//  - IMAGE:     upload the photo (initializeUpload, then PUT the bytes), then a post with content.media
//  - CAROUSEL:  upload each photo, then a post with content.multiImage (2 to 20 photos)
//  - VIDEO:     initializeUpload, PUT each ~4 MB part (read from Cloudinary by byte range, so the whole
//               file is never in memory), finalizeUpload, wait until processed, then a post with content.media
//
// Every URN and part is saved (ctx.saveState) as soon as LinkedIn returns it, so a retry resumes. Media
// uploaded twice is harmless: unused uploads never appear. The post itself can't be looked up afterwards
// (reading a member's posts is a restricted permission), so a marker is saved just before creating it:
// if a retry finds the marker without a result, we stop rather than risk posting twice.

const PROCESSING_POLL_MS = 30_000;
const NOT_READY_POLL_MS = 10_000;
/** How many times to wait for LinkedIn to finish processing media before giving up (about 10 minutes of checks). */
const MAX_NOT_READY = 20;
const MAX_IMAGE_BYTES = caps.image!.maxBytes;

interface LinkedInPublishState {
  /** Image URNs uploaded so far, in order. */
  images?: string[];
  video?: string;
  uploadToken?: string;
  parts?: { uploadUrl: string; firstByte: number; lastByte: number }[];
  /** ETags of the video parts uploaded so far, in order. */
  partIds?: string[];
  videoFinalized?: boolean;
  /** Set just before the call that creates the post; see above. */
  creating?: boolean;
  postId?: string;
  notReady?: number;
}

export function chooseFormat(media: FormatMedia[]): PostFormat | null {
  if (media.length === 0) return "TEXT";
  const videos = media.filter((m) => m.type === "VIDEO");
  if (videos.length === 0) return media.length === 1 ? "IMAGE" : "CAROUSEL";
  // LinkedIn posts can have several photos or one video, not a mix.
  return media.length === 1 ? "VIDEO" : null;
}

export function validatePost(req: PublishRequest): string[] {
  const problems: string[] = [];
  if (req.caption.length > caps.captionMaxLength) {
    problems.push(`Text is ${req.caption.length.toLocaleString("en")} characters; LinkedIn allows ${caps.captionMaxLength.toLocaleString("en")}.`);
  }
  if (req.media.length === 0 && !req.caption.trim()) problems.push("Write something or add a photo or video.");
  const videos = req.media.filter((m) => m.type === "VIDEO");
  if (videos.length > 0 && req.media.length > 1) problems.push("LinkedIn posts can have several photos or one video, not both.");
  if (req.media.length > caps.carouselMaxItems!) problems.push(`LinkedIn posts here can have at most ${caps.carouselMaxItems} photos.`);
  for (const v of videos) {
    if (v.format !== "mp4") problems.push("LinkedIn videos must be MP4.");
    if (v.bytes > caps.video!.maxBytes) problems.push("The video is larger than 500 MB.");
    if (v.bytes < MIN_VIDEO_BYTES) problems.push("The video is too small for LinkedIn (at least 75 KB).");
    if (v.durationSec != null && (v.durationSec < caps.video!.minSeconds || v.durationSec > caps.video!.maxSeconds)) {
      problems.push("LinkedIn videos must be between 3 seconds and 30 minutes long.");
    }
  }
  return problems;
}

export async function publish(app: li.LinkedInAppConfig, ctx: PublishContext): Promise<PublishResult> {
  const state = { ...(ctx.state as LinkedInPublishState) };
  const save = async (patch: LinkedInPublishState) => {
    Object.assign(state, patch);
    await ctx.saveState({ ...state });
  };
  const { accessToken: token, request } = ctx;
  const author = li.personUrn(ctx.accountExternalId);

  // Already published on an earlier attempt.
  if (state.postId) return published(state.postId);
  if (state.creating) {
    // Cleared so the user's own Retry (after checking their profile) posts again.
    await save({ creating: false });
    throw unconfirmed();
  }

  let content: li.PostContent | undefined;
  if (request.format === "IMAGE" || request.format === "CAROUSEL") {
    const images = [...(state.images ?? [])];
    for (let i = images.length; i < request.media.length; i++) {
      const upload = await li.initializeImageUpload(app, token, author);
      await li.uploadBytes(upload.uploadUrl, token, await download(request.media[i]!));
      images.push(upload.image);
      await save({ images });
    }
    content = request.format === "IMAGE" ? { media: { id: images[0]! } } : { multiImage: { images: images.map((id) => ({ id })) } };
  } else if (request.format === "VIDEO") {
    const ready = await uploadVideo(app, ctx, state, save, author);
    if (!ready) return { kind: "waiting", retryAfterMs: PROCESSING_POLL_MS };
    content = { media: { id: state.video! } };
  }

  await save({ creating: true });
  let postId: string;
  try {
    postId = await li.createPost(app, token, { author, text: request.caption, content });
  } catch (err) {
    // LinkedIn answered, so nothing was created and trying again is safe. If it couldn't be reached or
    // failed on its side we can't know: the marker stays, and the next attempt stops.
    if (err instanceof PlatformApiError && err.code !== "UNAVAILABLE") await save({ creating: false });
    // A photo or video LinkedIn hasn't finished processing: wait and try again.
    if (content && isNotReady(err) && (state.notReady ?? 0) < MAX_NOT_READY) {
      await save({ notReady: (state.notReady ?? 0) + 1 });
      return { kind: "waiting", retryAfterMs: NOT_READY_POLL_MS };
    }
    throw err;
  }
  await save({ postId, creating: false });
  return published(postId);
}

/** Uploads the video part by part, finalizes it, and reports whether LinkedIn has finished processing it. */
async function uploadVideo(
  app: li.LinkedInAppConfig,
  ctx: PublishContext,
  state: LinkedInPublishState,
  save: (s: LinkedInPublishState) => Promise<void>,
  author: string,
): Promise<boolean> {
  const { accessToken: token } = ctx;
  const video = ctx.request.media[0]!;

  if (!state.video) {
    const upload = await li.initializeVideoUpload(app, token, author, video.bytes);
    await save({ video: upload.video, uploadToken: upload.uploadToken, parts: upload.parts, partIds: [] });
  }
  if (!state.videoFinalized) {
    const partIds = [...(state.partIds ?? [])];
    for (let i = partIds.length; i < state.parts!.length; i++) {
      const part = state.parts![i]!;
      const etag = await li.uploadBytes(part.uploadUrl, token, await downloadRange(video, part.firstByte, part.lastByte));
      if (!etag) throw new PlatformApiError("LINKEDIN", "UNAVAILABLE", "LinkedIn didn't confirm a video part upload");
      partIds.push(etag);
      await save({ partIds });
    }
    await li.finalizeVideoUpload(app, token, { video: state.video!, uploadToken: state.uploadToken ?? "", partIds });
    await save({ videoFinalized: true });
  }

  let status: { status?: string; failureReason?: string };
  try {
    status = await li.getVideoStatus(app, token, state.video!);
  } catch (err) {
    // Some apps can't read video status: go ahead, and creating the post tells us if it isn't ready.
    if (err instanceof PlatformApiError && err.code === "PERMISSION_DENIED") return true;
    throw err;
  }
  if (status.status === "PROCESSING_FAILED") {
    throw new PlatformApiError("LINKEDIN", "MEDIA_REJECTED", `LinkedIn couldn't process the video${status.failureReason ? `: ${status.failureReason}` : ""}`);
  }
  return status.status === "AVAILABLE";
}

const published = (postId: string): PublishResult => ({ kind: "published", externalPostId: postId, permalink: li.postUrl(postId) });

function isNotReady(err: unknown): boolean {
  return (
    err instanceof PlatformApiError &&
    err.code === "BAD_REQUEST" &&
    /WAITING_UPLOAD|PROCESSING|not (yet )?(ready|available)/i.test(`${err.message} ${JSON.stringify(err.details ?? {})}`) &&
    !/PROCESSING_FAILED/i.test(err.message)
  );
}

/** A photo, as the processed JPEG from our storage. */
async function download(media: PublishMedia): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetchMedia(media.url, {});
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new PlatformApiError("LINKEDIN", "MEDIA_REJECTED", "The photo is too large for LinkedIn.");
  return bytes;
}

/** One part of a video, read by byte range so large videos are never held in memory whole. */
async function downloadRange(media: PublishMedia, firstByte: number, lastByte: number): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetchMedia(media.url, { Range: `bytes=${firstByte}-${lastByte}` });
  let bytes = new Uint8Array(await res.arrayBuffer());
  // A server that ignores Range sends the whole file.
  if (res.status === 200) bytes = bytes.subarray(firstByte, lastByte + 1);
  if (bytes.length !== lastByte - firstByte + 1) throw new PlatformApiError("LINKEDIN", "UNAVAILABLE", "Couldn't read the video from storage");
  return bytes;
}

async function fetchMedia(url: string, headers: Record<string, string>): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new PlatformApiError("LINKEDIN", "UNAVAILABLE", "Couldn't read the media from storage");
  }
  if (!res.ok) throw new PlatformApiError("LINKEDIN", "UNAVAILABLE", `Couldn't read the media from storage (HTTP ${res.status})`);
  return res;
}

/** Not retried automatically: a person should check their profile first. */
function unconfirmed() {
  return new PlatformApiError(
    "LINKEDIN",
    "BAD_REQUEST",
    "Couldn't confirm whether LinkedIn published this post. Check your LinkedIn profile; if it isn't there, retry.",
  );
}
