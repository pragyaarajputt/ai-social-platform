import { prisma } from "../config/database.js";
import type { Prisma } from "../generated/prisma/client.js";
import { getAdapter } from "../integrations/registry.js";
import type { PublishRequest } from "../integrations/types.js";
import type { CreatePostInput } from "../schemas/post.schemas.js";
import { thumbnailUrl } from "../storage/cloudinary.js";
import { AppError } from "../utils/AppError.js";
import { audit } from "./audit.service.js";

const postInclude = {
  media: { orderBy: { position: "asc" }, include: { mediaAsset: true } },
  targets: {
    orderBy: { createdAt: "asc" },
    include: { socialAccount: { select: { id: true, platform: true, username: true, name: true, avatarUrl: true, status: true } } },
  },
} as const satisfies Prisma.PostInclude;

type PostWithDetails = Prisma.PostGetPayload<{ include: typeof postInclude }>;

function toPublicPost(p: PostWithDetails) {
  return {
    id: p.id,
    caption: p.caption,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    media: p.media.map((m) => ({
      id: m.mediaAsset.id,
      type: m.mediaAsset.type,
      width: m.mediaAsset.width,
      height: m.mediaAsset.height,
      thumbnailUrl: thumbnailUrl(m.mediaAsset),
    })),
    targets: p.targets.map((t) => ({
      id: t.id,
      format: t.format,
      status: t.status,
      caption: t.captionOverride,
      permalink: t.permalink,
      publishedAt: t.publishedAt,
      nextAttemptAt: t.nextAttemptAt,
      attempts: t.attempts,
      lastErrorCode: t.lastErrorCode,
      lastError: t.lastError,
      account: t.socialAccount,
    })),
  };
}

/**
 * Validates the post for every chosen account, then creates the post, its media links and one
 * queued target per account in a single transaction: the worker can only ever see complete posts,
 * and a post can't be saved without being queued.
 */
export async function createPost(workspaceId: string, authorId: string, input: CreatePostInput) {
  const assets = await prisma.mediaAsset.findMany({ where: { id: { in: input.mediaIds }, workspaceId, deletedAt: null } });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const media = input.mediaIds.map((id) => byId.get(id));
  if (media.some((m) => !m)) throw new AppError(400, "MEDIA_NOT_FOUND", "Some media no longer exists. Remove it and try again.");

  const accountIds = input.targets.map((t) => t.socialAccountId);
  if (new Set(accountIds).size !== accountIds.length) throw new AppError(400, "DUPLICATE_TARGET", "Each account can only be chosen once");
  const accounts = await prisma.socialAccount.findMany({ where: { id: { in: accountIds }, workspaceId } });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const problems: { field: string; message: string }[] = [];
  const planned = input.targets.map((t, i) => {
    const account = accountById.get(t.socialAccountId);
    const field = `targets.${i}`;
    if (!account || account.status === "DISCONNECTED") {
      problems.push({ field, message: "This account isn't connected to the workspace." });
      return null;
    }
    const name = account.username ? `@${account.username}` : "This account";
    if (account.status !== "ACTIVE") {
      problems.push({ field, message: `${name} needs to be reconnected before you can publish to it.` });
      return null;
    }
    const adapter = getAdapter(account.platform);
    const format = adapter.chooseFormat(media.map((m) => ({ type: m!.type })));
    const request: PublishRequest = {
      format: format ?? "IMAGE",
      caption: t.captionOverride ?? input.caption,
      media: media.map((m) => ({ ...m!, url: m!.secureUrl })),
    };
    for (const message of adapter.validatePost(request)) problems.push({ field, message: `${name}: ${message}` });
    return format ? { ...t, format } : null;
  });
  if (problems.length) throw new AppError(400, "VALIDATION_ERROR", "This post can't be published as is", problems);

  const now = new Date();
  const post = await prisma.$transaction(async (tx) => {
    const created = await tx.post.create({
      data: {
        workspaceId,
        authorId,
        caption: input.caption,
        status: "PUBLISHING",
        media: { create: input.mediaIds.map((mediaAssetId, position) => ({ mediaAssetId, position })) },
        targets: {
          create: planned.map((t) => ({
            socialAccountId: t!.socialAccountId,
            captionOverride: t!.captionOverride ?? null,
            format: t!.format,
            status: "QUEUED" as const,
            nextAttemptAt: now,
          })),
        },
      },
      include: postInclude,
    });
    await audit(
      { action: "post.queued", workspaceId, actorId: authorId, targetType: "post", targetId: created.id, metadata: { targets: planned.length } },
      tx,
    );
    return created;
  });
  return toPublicPost(post);
}

export async function listPosts(workspaceId: string) {
  const posts = await prisma.post.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: postInclude,
  });
  return posts.map(toPublicPost);
}

export async function getPost(workspaceId: string, postId: string) {
  const post = await prisma.post.findFirst({ where: { id: postId, workspaceId }, include: postInclude });
  if (!post) throw new AppError(404, "POST_NOT_FOUND", "Post not found");
  return toPublicPost(post);
}

/** Puts a failed target back in the queue. Saved platform progress is kept, so nothing is posted twice. */
export async function retryTarget(workspaceId: string, postId: string, targetId: string, actorId: string) {
  const target = await prisma.postTarget.findFirst({
    where: { id: targetId, postId, post: { workspaceId } },
    include: { socialAccount: { select: { status: true, username: true } } },
  });
  if (!target) throw new AppError(404, "TARGET_NOT_FOUND", "Post target not found");
  if (target.status !== "FAILED") throw new AppError(409, "NOT_FAILED", "Only failed posts can be retried");
  if (target.socialAccount.status !== "ACTIVE") {
    throw new AppError(409, "ACCOUNT_NOT_READY", "Reconnect this account before retrying");
  }

  // Keep container IDs (so nothing is re-posted), but restart the video-processing wait timer.
  const { _waitingSince: _, ...platformState } = target.platformState as Record<string, unknown>;
  await prisma.$transaction(async (tx) => {
    await tx.postTarget.update({
      where: { id: target.id },
      data: {
        status: "QUEUED",
        nextAttemptAt: new Date(),
        lockedUntil: null,
        attempts: 0,
        lastError: null,
        lastErrorCode: null,
        platformState: platformState as Prisma.InputJsonObject,
      },
    });
    await tx.post.update({ where: { id: postId }, data: { status: "PUBLISHING" } });
    await audit({ action: "post.retried", workspaceId, actorId, targetType: "post_target", targetId: target.id }, tx);
  });
  return getPost(workspaceId, postId);
}
