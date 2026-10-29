import type { PostFormat } from "../../generated/prisma/enums.js";
import type { FormatMedia, PublishContext, PublishMedia, PublishRequest, PublishResult } from "../types.js";
import { PlatformApiError } from "../types.js";
import { blueskyCapabilities as caps } from "./capabilities.js";
import * as bsky from "./client.js";
import { BLUESKY_MAX_BYTES, BLUESKY_MAX_GRAPHEMES, BLUESKY_THREAD_MAX_POSTS, byteLength, detectFacets, graphemeLength, splitThread } from "./text.js";

// Publishing to Bluesky. The text becomes one post or a thread (text.ts); photos go on the first post,
// and each further post replies to the one before it (and names the first as the thread's root).
//  - photos: uploaded as blobs (com.atproto.repo.uploadBlob), then embedded in the first post
//  - posts:  com.atproto.repo.createRecord, in order
//
// Each post is created with a record key we generate and save first. Unlike most platforms, Bluesky
// lets anyone read a record by its key for free, so if an attempt dies without knowing whether a post
// went through, the retry simply looks it up: never a duplicate, and never a post given up on.

const MAX_IMAGE_BYTES = caps.image!.maxBytes;

interface BlueskyPublishState {
  /** Uploaded photos, in order. */
  blobs?: { blob: bsky.BlobRef; width: number; height: number }[];
  /** The thread's posts created so far, in order. */
  posts?: (bsky.StrongRef & { rkey: string })[];
  /** The post being created and the record key it was given; set just before the call. */
  pending?: { index: number; rkey: string };
}

export function chooseFormat(media: FormatMedia[]): PostFormat | null {
  if (media.length === 0) return "TEXT";
  if (media.some((m) => m.type === "VIDEO")) return null;
  return media.length === 1 ? "IMAGE" : "CAROUSEL";
}

export function validatePost(req: PublishRequest): string[] {
  const problems: string[] = [];
  const posts = splitThread(req.caption);
  if (req.media.length === 0 && posts.length === 0) problems.push("Write something or add a photo.");
  if (posts.length > BLUESKY_THREAD_MAX_POSTS) {
    problems.push(`This text makes a thread of ${posts.length} posts on Bluesky; threads here can have at most ${BLUESKY_THREAD_MAX_POSTS}. Shorten it.`);
  } else {
    const tooLong = posts.findIndex((p) => graphemeLength(p) > BLUESKY_MAX_GRAPHEMES || byteLength(p) > BLUESKY_MAX_BYTES);
    if (tooLong >= 0) problems.push(`Post ${tooLong + 1} of the thread is longer than Bluesky allows.`);
  }
  if (req.media.some((m) => m.type === "VIDEO")) problems.push("Videos can't be posted to Bluesky from PostDrip yet. Use photos, or remove Bluesky for this post.");
  else if (req.media.length > caps.carouselMaxItems!) problems.push(`Bluesky posts can have at most ${caps.carouselMaxItems} photos.`);
  return problems;
}

export async function publish(ctx: PublishContext): Promise<PublishResult> {
  const state = { ...(ctx.state as BlueskyPublishState) };
  const save = async (patch: BlueskyPublishState) => {
    Object.assign(state, patch);
    await ctx.saveState({ ...state });
  };
  const { accessToken: token, request, accountExternalId: did } = ctx;
  const parts = splitThread(request.caption);
  // A post with only photos has empty text.
  const texts = parts.length > 0 ? parts : [""];
  const posts = [...(state.posts ?? [])];
  const pds = await bsky.resolvePds(did);

  // An earlier attempt stopped mid-call: the record key tells us whether that post exists.
  if (state.pending) {
    const found = await bsky.getPost(pds, did, state.pending.rkey);
    if (found && state.pending.index === posts.length) posts.push({ ...found, rkey: state.pending.rkey });
    await save({ posts, pending: undefined });
  }
  if (posts.length >= texts.length) return published(did, posts[0]!.rkey);

  // Photos go on the first post only, so they're only needed until that post exists.
  let embed: Record<string, unknown> | undefined;
  if (posts.length === 0 && request.media.length > 0) {
    const blobs = [...(state.blobs ?? [])];
    for (let i = blobs.length; i < request.media.length; i++) {
      const m = request.media[i]!;
      blobs.push({ blob: await bsky.uploadBlob(pds, token, await download(m), "image/jpeg"), width: m.width, height: m.height });
      await save({ blobs });
    }
    embed = {
      $type: "app.bsky.embed.images",
      images: blobs.map((b) => ({
        image: b.blob,
        // Alt text is required by the format; PostDrip doesn't ask for it yet.
        alt: "",
        ...(b.width > 0 && b.height > 0 ? { aspectRatio: { width: b.width, height: b.height } } : {}),
      })),
    };
  }

  for (let i = posts.length; i < texts.length; i++) {
    const text = texts[i]!;
    const facets = await detectFacets(text, bsky.resolveHandle);
    const rkey = bsky.newTid();
    await save({ pending: { index: i, rkey } });
    let ref: bsky.StrongRef;
    try {
      ref = await bsky.createPost(pds, token, did, rkey, {
        text,
        createdAt: new Date().toISOString(),
        ...(facets.length ? { facets } : {}),
        ...(i === 0 && embed ? { embed } : {}),
        ...(i > 0 ? { reply: { root: strong(posts[0]!), parent: strong(posts[i - 1]!) } } : {}),
      });
    } catch (err) {
      // A clear refusal created nothing, so the key isn't worth checking; otherwise it stays for the retry.
      if (err instanceof PlatformApiError && err.code !== "UNAVAILABLE") await save({ pending: undefined });
      throw i === 0 ? err : partOfThread(err, i, texts.length);
    }
    posts.push({ ...ref, rkey });
    await save({ posts, pending: undefined });
  }
  return published(did, posts[0]!.rkey);
}

const strong = (p: bsky.StrongRef): bsky.StrongRef => ({ uri: p.uri, cid: p.cid });

const published = (did: string, rkey: string): PublishResult => ({
  kind: "published",
  externalPostId: `at://${did}/${bsky.POST_COLLECTION}/${rkey}`,
  permalink: bsky.postUrl(did, rkey),
});

/** A failure partway through a thread: the earlier posts are already live, and a retry carries on from here. */
function partOfThread(err: unknown, index: number, total: number): unknown {
  if (!(err instanceof PlatformApiError)) return err;
  const posted = `${index} of ${total} posts in the thread ${index === 1 ? "is" : "are"} on Bluesky`;
  return new PlatformApiError(err.platform, err.code, `${posted}; post ${index + 1} failed: ${err.message}`, err.details);
}

/** A photo, as the processed JPEG from our storage. */
async function download(media: PublishMedia): Promise<Uint8Array<ArrayBuffer>> {
  let res: Response;
  try {
    res = await fetch(media.url, { signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new PlatformApiError("BLUESKY", "UNAVAILABLE", "Couldn't read the media from storage");
  }
  if (!res.ok) throw new PlatformApiError("BLUESKY", "UNAVAILABLE", `Couldn't read the media from storage (HTTP ${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new PlatformApiError("BLUESKY", "MEDIA_REJECTED", "The photo is larger than Bluesky's 2 MB limit.");
  return bytes;
}
