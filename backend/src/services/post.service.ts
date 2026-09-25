import { prisma } from "../config/database.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { PostFormat, TargetStatus } from "../generated/prisma/enums.js";
import { getAdapter } from "../integrations/registry.js";
import type { PublishRequest } from "../integrations/types.js";
import type { CreatePostInput, ListPostsQuery, UpdatePostInput } from "../schemas/post.schemas.js";
import { AppError } from "../utils/AppError.js";
import { audit } from "./audit.service.js";
import { toPublicMedia } from "./media.service.js";

/** Scheduling window: far enough ahead to be meaningful, near enough to be deliberate. */
export const MIN_SCHEDULE_LEAD_MS = 2 * 60_000;
export const MAX_SCHEDULE_AHEAD_MS = 365 * 86_400_000;

const postInclude = {
  media: { orderBy: { position: "asc" }, include: { mediaAsset: true } },
  targets: {
    orderBy: { createdAt: "asc" },
    include: {
      socialAccount: {
        select: {
          id: true,
          platform: true,
          username: true,
          name: true,
          avatarUrl: true,
          status: true,
          token: { select: { expiresAt: true } },
        },
      },
    },
  },
} as const satisfies Prisma.PostInclude;

type PostWithDetails = Prisma.PostGetPayload<{ include: typeof postInclude }>;

/** Why a scheduled target will probably fail, if it will. */
export type TargetRisk = "ACCOUNT_NEEDS_RECONNECT" | "ACCESS_EXPIRES_BEFORE_POST" | null;

function riskOf(target: { status: TargetStatus; scheduledAt: Date | null }, account: { status: string; token: { expiresAt: Date | null } | null }): TargetRisk {
  if (target.status !== "SCHEDULED") return null;
  if (account.status !== "ACTIVE" || !account.token) return "ACCOUNT_NEEDS_RECONNECT";
  if (target.scheduledAt && account.token.expiresAt && account.token.expiresAt <= target.scheduledAt) return "ACCESS_EXPIRES_BEFORE_POST";
  return null;
}

function toPublicPost(p: PostWithDetails) {
  return {
    id: p.id,
    caption: p.caption,
    status: p.status,
    scheduledAt: p.scheduledAt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    media: p.media.map((m) => toPublicMedia(m.mediaAsset)),
    targets: p.targets.map((t) => {
      const { token, ...account } = t.socialAccount;
      return {
        id: t.id,
        format: t.format,
        status: t.status,
        caption: t.captionOverride,
        scheduledAt: t.scheduledAt,
        permalink: t.permalink,
        publishedAt: t.publishedAt,
        nextAttemptAt: t.nextAttemptAt,
        attempts: t.attempts,
        lastErrorCode: t.lastErrorCode,
        lastError: t.lastError,
        risk: riskOf(t, t.socialAccount),
        account: { ...account, tokenExpiresAt: token?.expiresAt ?? null },
      };
    }),
  };
}

// ─── Validation shared by create and edit ───────────────────────────────────

interface PostPlan {
  caption: string;
  mediaIds: string[];
  targets: { socialAccountId: string; captionOverride: string | null; format: PostFormat }[];
  scheduledAt: Date | null;
}

function assertScheduleWindow(scheduledAt: Date | null, now: Date) {
  if (!scheduledAt) return;
  const ahead = scheduledAt.getTime() - now.getTime();
  const problem =
    ahead < MIN_SCHEDULE_LEAD_MS
      ? "Choose a time at least 2 minutes from now, or publish now."
      : ahead > MAX_SCHEDULE_AHEAD_MS
        ? "Posts can be scheduled up to a year ahead."
        : null;
  if (problem) throw new AppError(400, "VALIDATION_ERROR", "This post can't be scheduled for that time", [{ field: "scheduledAt", message: problem }]);
}

/** Checks media, accounts and each platform's rules; returns what to save. */
async function planPost(
  workspaceId: string,
  input: { caption: string; mediaIds: string[]; targets: { socialAccountId: string; captionOverride?: string | null }[]; scheduledAt: Date | null },
  now: Date,
  options: { checkScheduleWindow: boolean } = { checkScheduleWindow: true },
): Promise<PostPlan> {
  if (options.checkScheduleWindow) assertScheduleWindow(input.scheduledAt, now);

  const assets = await prisma.mediaAsset.findMany({ where: { id: { in: input.mediaIds }, workspaceId, deletedAt: null } });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const media = input.mediaIds.map((id) => byId.get(id));
  if (media.some((m) => !m)) throw new AppError(400, "MEDIA_NOT_FOUND", "Some media no longer exists. Remove it and try again.");

  const accountIds = input.targets.map((t) => t.socialAccountId);
  if (new Set(accountIds).size !== accountIds.length) throw new AppError(400, "DUPLICATE_TARGET", "Each account can only be chosen once");
  const accounts = await prisma.socialAccount.findMany({ where: { id: { in: accountIds }, workspaceId } });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const problems: { field: string; message: string }[] = [];
  const targets = input.targets.map((t, i) => {
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
    return format ? { socialAccountId: t.socialAccountId, captionOverride: t.captionOverride ?? null, format } : null;
  });
  if (problems.length) throw new AppError(400, "VALIDATION_ERROR", "This post can't be published as is", problems);

  return { caption: input.caption, mediaIds: input.mediaIds, targets: targets.map((t) => t!), scheduledAt: input.scheduledAt };
}

/** Rows to create for a plan: scheduled posts wait for their time, others are due now. */
function targetRows(plan: PostPlan, now: Date) {
  return plan.targets.map((t) => ({
    ...t,
    status: (plan.scheduledAt ? "SCHEDULED" : "QUEUED") as TargetStatus,
    scheduledAt: plan.scheduledAt,
    nextAttemptAt: plan.scheduledAt ?? now,
  }));
}

// ─── Create, read ───────────────────────────────────────────────────────────

/**
 * Creates the post, its media links and one target per account in a single transaction: the worker
 * only ever sees complete posts, and a post can't be saved without being queued or scheduled.
 */
export async function createPost(workspaceId: string, authorId: string, input: CreatePostInput) {
  const now = new Date();
  const plan = await planPost(workspaceId, { ...input, scheduledAt: input.scheduledAt ?? null }, now);

  const post = await prisma.$transaction(async (tx) => {
    const created = await tx.post.create({
      data: {
        workspaceId,
        authorId,
        caption: plan.caption,
        status: plan.scheduledAt ? "SCHEDULED" : "PUBLISHING",
        scheduledAt: plan.scheduledAt,
        media: { create: plan.mediaIds.map((mediaAssetId, position) => ({ mediaAssetId, position })) },
        targets: { create: targetRows(plan, now) },
      },
      include: postInclude,
    });
    await audit(
      {
        action: plan.scheduledAt ? "post.scheduled" : "post.queued",
        workspaceId,
        actorId: authorId,
        targetType: "post",
        targetId: created.id,
        metadata: { targets: plan.targets.length, scheduledAt: plan.scheduledAt?.toISOString() ?? null },
      },
      tx,
    );
    return created;
  });
  return toPublicPost(post);
}

export async function listPosts(workspaceId: string, query: ListPostsQuery = {}) {
  const where: Prisma.PostWhereInput = { workspaceId };
  if (query.status?.length) where.status = { in: query.status };
  if (query.from || query.to) {
    // A post's date is its scheduled time, or its creation time if it was published right away.
    const range = { ...(query.from && { gte: query.from }), ...(query.to && { lt: query.to }) };
    where.OR = [{ scheduledAt: range }, { scheduledAt: null, createdAt: range }];
  }
  const scheduledOnly = query.status?.length === 1 && query.status[0] === "SCHEDULED";
  const posts = await prisma.post.findMany({
    where,
    // Upcoming posts read best soonest-first; everything else newest-first.
    orderBy: scheduledOnly ? { scheduledAt: "asc" } : { createdAt: "desc" },
    take: query.from || query.to ? 500 : 100,
    include: postInclude,
  });
  return posts.map(toPublicPost);
}

export async function getPost(workspaceId: string, postId: string) {
  const post = await prisma.post.findFirst({ where: { id: postId, workspaceId }, include: postInclude });
  if (!post) throw new AppError(404, "POST_NOT_FOUND", "Post not found");
  return toPublicPost(post);
}

// ─── Changing a scheduled post ──────────────────────────────────────────────

/**
 * Locks the post's targets (FOR UPDATE) and checks none has started publishing. The worker claims
 * rows with SKIP LOCKED, so while we hold the lock it skips this post, and once we commit it sees
 * the new state. If the worker got there first, the caller gets a 409 instead of a half-edited post.
 */
async function lockUntouchedTargets(tx: Prisma.TransactionClient, postId: string, allowed: TargetStatus[], message: string) {
  const rows = await tx.$queryRaw<{ id: string; status: TargetStatus }[]>`
    SELECT id, status FROM post_targets WHERE post_id = ${postId}::uuid FOR UPDATE`;
  if (rows.some((r) => !allowed.includes(r.status))) throw new AppError(409, "POST_LOCKED", message);
  return rows;
}

async function findPostForChange(workspaceId: string, postId: string) {
  const post = await prisma.post.findFirst({ where: { id: postId, workspaceId }, include: postInclude });
  if (!post) throw new AppError(404, "POST_NOT_FOUND", "Post not found");
  return post;
}

/** Edits a scheduled post. `scheduledAt: null` publishes it now. */
export async function updatePost(workspaceId: string, postId: string, actorId: string, input: UpdatePostInput) {
  const current = await findPostForChange(workspaceId, postId);
  // Checked first (and again under the lock below), so a post the worker has picked up gets a
  // clear 409 rather than a validation error about its time.
  if (current.status !== "SCHEDULED" || current.targets.some((t) => t.status !== "SCHEDULED")) {
    throw new AppError(409, "POST_LOCKED", "This post has started publishing and can't be changed.");
  }
  const now = new Date();
  const plan = await planPost(
    workspaceId,
    {
      caption: input.caption ?? current.caption,
      mediaIds: input.mediaIds ?? current.media.map((m) => m.mediaAssetId),
      targets: input.targets ?? current.targets.map((t) => ({ socialAccountId: t.socialAccountId, captionOverride: t.captionOverride })),
      scheduledAt: input.scheduledAt === undefined ? current.scheduledAt : input.scheduledAt,
    },
    now,
    // Only a new time has to be in the scheduling window; editing the caption of a post due in
    // 90 seconds keeps its time.
    { checkScheduleWindow: input.scheduledAt !== undefined },
  );

  await prisma.$transaction(async (tx) => {
    await lockUntouchedTargets(tx, postId, ["SCHEDULED"], "This post has started publishing and can't be changed.");
    // Nothing has been sent anywhere yet, so the targets and media list can simply be replaced.
    await tx.postTarget.deleteMany({ where: { postId } });
    await tx.postMedia.deleteMany({ where: { postId } });
    await tx.post.update({
      where: { id: postId },
      data: {
        caption: plan.caption,
        status: plan.scheduledAt ? "SCHEDULED" : "PUBLISHING",
        scheduledAt: plan.scheduledAt,
        media: { create: plan.mediaIds.map((mediaAssetId, position) => ({ mediaAssetId, position })) },
        targets: { create: targetRows(plan, now) },
      },
    });
    await audit(
      {
        action: plan.scheduledAt ? "post.rescheduled" : "post.published_early",
        workspaceId,
        actorId,
        targetType: "post",
        targetId: postId,
        metadata: { scheduledAt: plan.scheduledAt?.toISOString() ?? null },
      },
      tx,
    );
  });
  return getPost(workspaceId, postId);
}

export async function cancelPost(workspaceId: string, postId: string, actorId: string) {
  await findPostForChange(workspaceId, postId);
  await prisma.$transaction(async (tx) => {
    await lockUntouchedTargets(tx, postId, ["SCHEDULED"], "Only scheduled posts that haven't started publishing can be cancelled.");
    await tx.postTarget.updateMany({ where: { postId }, data: { status: "CANCELLED", nextAttemptAt: null } });
    await tx.post.update({ where: { id: postId }, data: { status: "CANCELLED" } });
    await audit({ action: "post.cancelled", workspaceId, actorId, targetType: "post", targetId: postId }, tx);
  });
  return getPost(workspaceId, postId);
}

/** Deletes a post that never reached any platform (scheduled, cancelled or failed everywhere). */
export async function deletePost(workspaceId: string, postId: string, actorId: string) {
  const post = await findPostForChange(workspaceId, postId);
  if (post.targets.some((t) => t.externalPostId)) {
    throw new AppError(409, "POST_LOCKED", "This post was published, so it can't be deleted here.");
  }
  await prisma.$transaction(async (tx) => {
    await lockUntouchedTargets(tx, postId, ["SCHEDULED", "CANCELLED", "FAILED"], "This post is being published and can't be deleted right now.");
    await tx.post.delete({ where: { id: postId } });
    await audit({ action: "post.deleted", workspaceId, actorId, targetType: "post", targetId: postId }, tx);
  });
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
        // A manual retry means "publish now": clear the target's schedule, or a post marked missed
        // would be marked missed again. The post keeps its original scheduled time.
        scheduledAt: null,
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

// ─── At-risk scheduled posts ────────────────────────────────────────────────

/** Scheduled targets due within `withinMs` that will probably fail (used by the dashboard and the pre-flight job). */
export async function findAtRiskTargets(params: { workspaceId?: string; withinMs: number; now?: Date; onlyUnwarned?: boolean }) {
  const now = params.now ?? new Date();
  const targets = await prisma.postTarget.findMany({
    where: {
      status: "SCHEDULED",
      scheduledAt: { gte: now, lte: new Date(now.getTime() + params.withinMs) },
      ...(params.onlyUnwarned && { preflightWarnedAt: null }),
      ...(params.workspaceId && { post: { workspaceId: params.workspaceId } }),
    },
    include: {
      post: { select: { id: true, workspaceId: true, caption: true, authorId: true, author: { select: { email: true } } } },
      socialAccount: { select: { id: true, username: true, status: true, token: { select: { expiresAt: true } } } },
    },
    orderBy: { scheduledAt: "asc" },
  });
  return targets
    .map((t) => ({ target: t, risk: riskOf(t, t.socialAccount) }))
    .filter((x): x is { target: (typeof targets)[number]; risk: Exclude<TargetRisk, null> } => x.risk !== null);
}

export async function listAtRisk(workspaceId: string) {
  const risky = await findAtRiskTargets({ workspaceId, withinMs: 24 * 3_600_000 });
  return risky.map(({ target, risk }) => ({
    postId: target.post.id,
    targetId: target.id,
    caption: target.post.caption,
    scheduledAt: target.scheduledAt,
    account: { id: target.socialAccount.id, username: target.socialAccount.username },
    risk,
  }));
}
