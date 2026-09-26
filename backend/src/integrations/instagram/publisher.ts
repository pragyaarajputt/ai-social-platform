import type { PostFormat } from "../../generated/prisma/enums.js";
import type { FormatMedia, PublishContext, PublishRequest, PublishResult } from "../types.js";
import { PlatformApiError } from "../types.js";
import { instagramCapabilities as caps } from "./capabilities.js";
import * as ig from "./client.js";

// Publishing to Instagram is: create container(s) → wait until processed → publish → fetch link.
// Every ID is saved (ctx.saveState) the moment Instagram returns it, and each call resumes from what
// was saved. That makes retries safe:
//  - a container is never created twice for the same post;
//  - Instagram publishes a container only once, and a container already PUBLISHED (we crashed after
//    publishing but before saving) is recovered from the account's recent posts, not published again.

const PROCESSING_POLL_MS = 30_000;

interface InstagramPublishState {
  childIds?: string[];
  containerId?: string;
  mediaId?: string;
}

export function chooseFormat(media: FormatMedia[]): PostFormat | null {
  if (media.length === 0) return null; // Instagram has no text-only posts
  if (media.length > 1) return "CAROUSEL";
  return media[0]!.type === "VIDEO" ? "REEL" : "IMAGE";
}

export function validatePost(req: PublishRequest): string[] {
  const problems: string[] = [];
  const count = (re: RegExp) => (req.caption.match(re) ?? []).length;

  if (req.caption.length > caps.captionMaxLength) {
    problems.push(`Caption is ${req.caption.length} characters; Instagram allows ${caps.captionMaxLength}.`);
  }
  if (count(/(^|\s)#[\p{L}\p{N}_]+/gu) > caps.hashtagMax!) problems.push(`Instagram allows at most ${caps.hashtagMax} hashtags.`);
  if (count(/(^|\s)@[\w.]+/g) > caps.mentionMax!) problems.push(`Instagram allows at most ${caps.mentionMax} @mentions.`);

  if (req.media.length === 0) problems.push("Instagram posts need at least one photo or video.");
  if (req.media.length > caps.carouselMaxItems!) problems.push(`Instagram carousels can have at most ${caps.carouselMaxItems} items.`);

  req.media.forEach((m, i) => {
    const label = req.media.length > 1 ? `Item ${i + 1}` : m.type === "VIDEO" ? "The video" : "The image";
    if (m.type === "IMAGE") {
      const ratio = m.width / m.height;
      const img = caps.image!;
      if (ratio < img.minAspectRatio - 0.005 || ratio > img.maxAspectRatio + 0.005) {
        problems.push(`${label} has aspect ratio ${m.width}:${m.height}; Instagram needs between 4:5 (portrait) and 1.91:1 (landscape).`);
      }
      if (m.width < 320) problems.push(`${label} is ${m.width} px wide; Instagram needs at least 320 px.`);
    } else {
      const vid = caps.video!;
      if (!["mp4", "mov"].includes(m.format)) problems.push(`${label} must be MP4 or MOV.`);
      if (m.bytes > vid.maxBytes) problems.push(`${label} is larger than ${vid.maxBytes / 1024 / 1024} MB.`);
      if (m.durationSec != null && (m.durationSec < vid.minSeconds || m.durationSec > vid.maxSeconds)) {
        problems.push(`${label} is ${Math.round(m.durationSec)} s long; Instagram needs ${vid.minSeconds} s to ${vid.maxSeconds / 60} minutes.`);
      }
    }
  });
  return problems;
}

export async function publish(app: ig.InstagramAppConfig, ctx: PublishContext): Promise<PublishResult> {
  const state = { ...(ctx.state as InstagramPublishState) };
  const save = async (patch: InstagramPublishState) => {
    Object.assign(state, patch);
    await ctx.saveState({ ...state });
  };
  const { accessToken, accountExternalId: igUserId, request } = ctx;

  // Already published on an earlier attempt: just make sure we have the link.
  if (state.mediaId) return { kind: "published", externalPostId: state.mediaId, permalink: await tryPermalink(app, state.mediaId, accessToken) };

  // 1. Containers
  if (!state.containerId) {
    if (request.format === "CAROUSEL") {
      const childIds = [...(state.childIds ?? [])];
      for (let i = childIds.length; i < request.media.length; i++) {
        const m = request.media[i]!;
        const params: Record<string, string> =
          m.type === "VIDEO" ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: "true" } : { image_url: m.url, is_carousel_item: "true" };
        childIds.push(await ig.createContainer(app, igUserId, accessToken, params));
        await save({ childIds });
      }
      // Carousel videos must finish processing before the carousel itself can be created.
      for (const childId of childIds) {
        const child = await ig.getContainerStatus(app, childId, accessToken);
        const step = interpret(child.statusCode, child.status);
        if (step === "waiting") return { kind: "waiting", retryAfterMs: PROCESSING_POLL_MS };
        if (step === "expired") return restartExpired(save);
      }
      await save({
        containerId: await ig.createContainer(app, igUserId, accessToken, {
          media_type: "CAROUSEL",
          children: childIds.join(","),
          caption: request.caption,
        }),
      });
    } else {
      const m = request.media[0]!;
      const params: Record<string, string> =
        request.format === "REEL"
          ? { media_type: "REELS", video_url: m.url, caption: request.caption, share_to_feed: "true" }
          : { image_url: m.url, caption: request.caption };
      await save({ containerId: await ig.createContainer(app, igUserId, accessToken, params) });
    }
  }

  // 2. Wait until Instagram has processed it
  const container = await ig.getContainerStatus(app, state.containerId!, accessToken);
  if (container.statusCode === "PUBLISHED") return recoverPublished(app, ctx, save);
  const step = interpret(container.statusCode, container.status);
  if (step === "waiting") return { kind: "waiting", retryAfterMs: PROCESSING_POLL_MS };
  if (step === "expired") return restartExpired(save);

  // 3. Publish, and save the media ID before anything else can fail
  const mediaId = await ig.publishContainer(app, igUserId, accessToken, state.containerId!);
  await save({ mediaId });

  // 4. Link (best effort: the post is live even if this call fails)
  return { kind: "published", externalPostId: mediaId, permalink: await tryPermalink(app, mediaId, accessToken) };
}

function interpret(statusCode: ig.ContainerStatus, status?: string): "ready" | "waiting" | "expired" {
  switch (statusCode) {
    case "FINISHED":
      return "ready";
    case "IN_PROGRESS":
      return "waiting";
    case "EXPIRED":
      return "expired";
    case "ERROR":
      throw new PlatformApiError("INSTAGRAM", "MEDIA_REJECTED", `Instagram couldn't process the media${status ? `: ${status}` : ""}`);
    default:
      throw new PlatformApiError("INSTAGRAM", "UNAVAILABLE", `Unexpected container status "${statusCode}"`);
  }
}

/** Containers expire 24 h after creation. Start over; nothing was published. */
async function restartExpired(save: (s: InstagramPublishState) => Promise<void>): Promise<never> {
  await save({ childIds: undefined, containerId: undefined });
  throw new PlatformApiError("INSTAGRAM", "MEDIA_EXPIRED", "Instagram's upload expired before publishing; it will be retried");
}

/**
 * The container says PUBLISHED but we never saved the media ID: we crashed right after publishing.
 * Find the post among the account's latest media instead of publishing again.
 */
async function recoverPublished(
  app: ig.InstagramAppConfig,
  ctx: PublishContext,
  save: (s: InstagramPublishState) => Promise<void>,
): Promise<PublishResult> {
  const recent = await ig.listRecentMedia(app, ctx.accountExternalId, ctx.accessToken);
  const since = ctx.startedAt.getTime() - 60_000;
  const match = recent.find((m) => m.timestamp && new Date(m.timestamp).getTime() >= since);
  if (match) {
    await save({ mediaId: match.id });
    return { kind: "published", externalPostId: match.id, permalink: match.permalink };
  }
  // Published for sure, but we can't tell which post it is. Better no link than a second post.
  return { kind: "published" };
}

async function tryPermalink(app: ig.InstagramAppConfig, mediaId: string, accessToken: string) {
  try {
    return await ig.getPermalink(app, mediaId, accessToken);
  } catch {
    return undefined;
  }
}
