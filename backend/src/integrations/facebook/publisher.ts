import type { PostFormat } from "../../generated/prisma/enums.js";
import type { FormatMedia, PublishContext, PublishRequest, PublishResult } from "../types.js";
import { PlatformApiError } from "../types.js";
import { facebookCapabilities as caps, REEL } from "./capabilities.js";
import * as fb from "./client.js";

// Publishing to a Facebook Page, by format:
//  - TEXT:      POST /{page}/feed
//  - IMAGE:     POST /{page}/photos (published)
//  - CAROUSEL:  each photo unpublished, then POST /{page}/feed with attached_media (a multi-photo post)
//  - VIDEO:     POST /{page}/videos with file_url, then wait until processed
//  - REEL:      start → upload from URL → finish, then wait until processed and published
//
// Every ID is saved (ctx.saveState) as soon as Facebook returns it, and each call resumes from what
// was saved. The one step that can't be checked is the final "create the post" call, so a marker is
// saved just before it. If a retry finds the marker without a result, we crashed around that call:
// the post is looked up among the Page's recent posts, and if it can't be found we stop rather than
// risk posting it twice.

const PROCESSING_POLL_MS = 30_000;

interface FacebookPublishState {
  photoIds?: string[];
  /** Set just before the call that creates the post; see above. */
  creating?: boolean;
  postId?: string;
  videoId?: string;
  reelUploaded?: boolean;
  reelFinished?: boolean;
}

export function isReel(m: FormatMedia): boolean {
  return (
    m.width > 0 &&
    m.height > 0 &&
    m.width / m.height <= REEL.maxAspectRatio &&
    m.width >= REEL.minWidth &&
    m.durationSec != null &&
    m.durationSec >= REEL.minSeconds &&
    m.durationSec <= REEL.maxSeconds
  );
}

export function chooseFormat(media: FormatMedia[]): PostFormat | null {
  if (media.length === 0) return "TEXT";
  const videos = media.filter((m) => m.type === "VIDEO");
  if (videos.length === 0) return media.length === 1 ? "IMAGE" : "CAROUSEL";
  // Facebook posts can have several photos or one video, not a mix.
  if (media.length > 1) return null;
  return isReel(videos[0]!) ? "REEL" : "VIDEO";
}

export function validatePost(req: PublishRequest): string[] {
  const problems: string[] = [];
  if (req.caption.length > caps.captionMaxLength) {
    problems.push(`Text is ${req.caption.length.toLocaleString("en")} characters; Facebook allows ${caps.captionMaxLength.toLocaleString("en")}.`);
  }
  const videos = req.media.filter((m) => m.type === "VIDEO");
  if (videos.length > 0 && req.media.length > 1) problems.push("Facebook posts can have several photos or one video, not both.");
  if (req.media.length === 0 && !req.caption.trim()) problems.push("Write something or add a photo or video.");
  if (req.media.length > caps.carouselMaxItems!) problems.push(`Facebook posts here can have at most ${caps.carouselMaxItems} photos.`);
  for (const v of videos) {
    if (!["mp4", "mov"].includes(v.format)) problems.push("The video must be MP4 or MOV.");
    if (v.bytes > caps.video!.maxBytes) problems.push("The video is larger than 1 GB.");
  }
  return problems;
}

export async function publish(app: fb.FacebookAppConfig, ctx: PublishContext): Promise<PublishResult> {
  const state = { ...(ctx.state as FacebookPublishState) };
  const save = async (patch: FacebookPublishState) => {
    Object.assign(state, patch);
    await ctx.saveState({ ...state });
  };
  const { accessToken: token, accountExternalId: pageId, request } = ctx;

  if (request.format === "VIDEO" || request.format === "REEL") return publishVideo(app, ctx, state, save);

  // Already published on an earlier attempt: just make sure we have the link.
  if (state.postId) return { kind: "published", externalPostId: state.postId, permalink: await tryPermalink(app, state.postId, token) };

  // Unpublished photos for a multi-photo post. Uploading a photo twice is harmless: unused ones never appear.
  let photoIds = state.photoIds ?? [];
  if (request.format === "CAROUSEL") {
    photoIds = [...photoIds];
    for (let i = photoIds.length; i < request.media.length; i++) {
      photoIds.push((await fb.uploadPhoto(app, pageId, token, { url: request.media[i]!.url, published: false })).photoId);
      await save({ photoIds });
    }
  }

  if (state.creating) {
    const recovered = await recoverPost(app, ctx, save);
    await save({ postId: recovered.id, creating: false });
    return { kind: "published", externalPostId: recovered.id, permalink: recovered.permalink };
  }

  await save({ creating: true });
  const postId = await creatingPost(save, async () => {
    if (request.format === "IMAGE") {
      const photo = await fb.uploadPhoto(app, pageId, token, { url: request.media[0]!.url, caption: request.caption, published: true });
      return photo.postId ?? `${pageId}_${photo.photoId}`;
    }
    const params: Record<string, string> = { message: request.caption };
    photoIds.forEach((id, i) => (params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id })));
    return fb.createFeedPost(app, pageId, token, params);
  });
  await save({ postId, creating: false });
  return { kind: "published", externalPostId: postId, permalink: await tryPermalink(app, postId, token) };
}

async function publishVideo(
  app: fb.FacebookAppConfig,
  ctx: PublishContext,
  state: FacebookPublishState,
  save: (s: FacebookPublishState) => Promise<void>,
): Promise<PublishResult> {
  const { accessToken: token, accountExternalId: pageId, request } = ctx;
  const video = request.media[0]!;

  if (request.format === "REEL") {
    // start → upload → finish, each saved as it completes.
    if (!state.videoId) await save({ videoId: await fb.startReel(app, pageId, token) });
    if (!state.reelUploaded) {
      await fb.uploadReelFromUrl(app, state.videoId!, token, video.url);
      await save({ reelUploaded: true });
    }
    if (!state.reelFinished) {
      // A crash right after "finish": if publishing already started, don't finish again.
      const already = state.creating ? await fb.getVideoStatus(app, state.videoId!, token) : null;
      if (!already?.publishingStatus || already.publishingStatus === "not_started") {
        await save({ creating: true });
        await creatingPost(save, () => fb.finishReel(app, pageId, token, state.videoId!, request.caption));
      }
      await save({ reelFinished: true, creating: false });
    }
  } else if (!state.videoId) {
    if (state.creating) {
      // Crashed while uploading the video: it may exist already. Don't post it twice.
      await save({ creating: false });
      throw unconfirmed();
    }
    await save({ creating: true });
    const videoId = await creatingPost(save, () => fb.uploadVideo(app, pageId, token, { fileUrl: video.url, description: request.caption }));
    await save({ videoId, creating: false });
  }

  // Facebook processes the video (and publishes a Reel) asynchronously.
  const status = await fb.getVideoStatus(app, state.videoId!, token);
  if (status.videoStatus === "error" || status.publishingStatus === "error") {
    throw new PlatformApiError("FACEBOOK", "MEDIA_REJECTED", `Facebook couldn't process the video${status.errorMessage ? `: ${status.errorMessage}` : ""}`);
  }
  const done = status.videoStatus === "ready" && (request.format !== "REEL" || status.publishingStatus === "complete");
  if (!done) return { kind: "waiting", retryAfterMs: PROCESSING_POLL_MS };
  const postId = status.postId ?? state.videoId!;
  await save({ postId });
  return { kind: "published", externalPostId: postId, permalink: status.permalink };
}

/**
 * We crashed around the call that creates the post. If Facebook created it, it's among the Page's
 * latest posts with our text, created after we started. Otherwise stop instead of guessing.
 */
async function recoverPost(app: fb.FacebookAppConfig, ctx: PublishContext, save: (s: FacebookPublishState) => Promise<void>) {
  const recent = await fb.listRecentPosts(app, ctx.accountExternalId, ctx.accessToken);
  const since = ctx.startedAt.getTime() - 60_000;
  const match = recent.find((p) => p.createdTime && Date.parse(p.createdTime) >= since && p.message.trim() === ctx.request.caption.trim());
  if (!match) {
    // Cleared so the user's own Retry (after checking the Page) posts again.
    await save({ creating: false });
    throw unconfirmed();
  }
  return match;
}

/**
 * Runs the call that creates the post. If Facebook answered with an error, nothing was created, so the
 * marker is cleared and a normal retry is safe. If Facebook couldn't be reached or failed on its side,
 * we can't know: the marker stays and the next attempt checks the Page first.
 */
async function creatingPost<T>(save: (s: FacebookPublishState) => Promise<void>, create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (err) {
    if (err instanceof PlatformApiError && err.code !== "UNAVAILABLE") await save({ creating: false });
    throw err;
  }
}

/** Not retried automatically: a person should check the Page first. */
function unconfirmed() {
  return new PlatformApiError(
    "FACEBOOK",
    "BAD_REQUEST",
    "Couldn't confirm whether Facebook published this post. Check the Page; if it isn't there, retry.",
  );
}

async function tryPermalink(app: fb.FacebookAppConfig, postId: string, token: string) {
  try {
    return await fb.getPostPermalink(app, postId, token);
  } catch {
    return undefined;
  }
}
