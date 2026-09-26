import { prisma } from "../config/database.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { PostStatus, TargetStatus } from "../generated/prisma/enums.js";
import { getAdapter } from "../integrations/registry.js";
import { PlatformApiError } from "../integrations/types.js";
import { audit } from "../services/audit.service.js";
import { deliveryUrl } from "../storage/cloudinary.js";
import { decryptToken } from "../utils/tokenCrypto.js";

// The publish queue lives in Postgres: each post_targets row is a job. A worker claims due rows with
// SELECT ... FOR UPDATE SKIP LOCKED, so several workers never take the same one, and a lock that
// expires (the worker died mid-publish) makes the row claimable again. See worker.ts.

const LOCK_MS = 5 * 60_000;
/** Waits before retries 1, 2, 3, 4; the 5th failure is final. */
const RETRY_BACKOFF_MS = [30_000, 2 * 60_000, 8 * 60_000, 30 * 60_000];
const MAX_ATTEMPTS = RETRY_BACKOFF_MS.length + 1;
/** How long to keep waiting for a platform to process video before giving up. */
const MAX_PROCESSING_WAIT_MS = 30 * 60_000;
/**
 * A scheduled post whose time passed more than this long ago (e.g. the worker was down) is marked
 * missed instead of published: a week-old "sale ends tonight" post shouldn't suddenly appear.
 */
export const MAX_SCHEDULE_LATENESS_MS = 24 * 3_600_000;

/** Claims up to `limit` due targets for this worker. */
export async function claimDueTargets(limit: number, now = new Date()): Promise<string[]> {
  const lockedUntil = new Date(now.getTime() + LOCK_MS);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE post_targets
    SET status = 'PUBLISHING', locked_until = ${lockedUntil}, updated_at = ${now}
    WHERE id IN (
      SELECT id FROM post_targets
      WHERE status IN ('SCHEDULED', 'QUEUED', 'WAITING_FOR_MEDIA', 'PUBLISHING')
        AND next_attempt_at <= ${now}
        AND (locked_until IS NULL OR locked_until < ${now})
      ORDER BY next_attempt_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  return rows.map((r) => r.id);
}

type Outcome = "published" | "waiting" | "retry_scheduled" | "failed";

/** Publishes one claimed target, then records what happened. Never throws. */
export async function processTarget(targetId: string, now = new Date()): Promise<Outcome> {
  const target = await prisma.postTarget.findUnique({
    where: { id: targetId },
    include: {
      post: { include: { media: { orderBy: { position: "asc" }, include: { mediaAsset: true } } } },
      socialAccount: { include: { token: true } },
    },
  });
  if (!target) return "failed";

  const account = target.socialAccount;
  const startedAt = new Date();
  const state = { ...(target.platformState as Record<string, unknown>) };
  const firstStartedAt = typeof state._startedAt === "string" ? new Date(state._startedAt) : startedAt;
  state._startedAt = firstStartedAt.toISOString();

  // Too late to publish a scheduled post that hasn't started (nothing was sent to the platform yet).
  const notStarted = target.attempts === 0 && Object.keys(target.platformState as object).length === 0;
  if (target.scheduledAt && notStarted && now.getTime() - target.scheduledAt.getTime() > MAX_SCHEDULE_LATENESS_MS) {
    return fail(
      target.id,
      target.post.id,
      target.attempts,
      startedAt,
      "MISSED_SCHEDULE",
      "This post missed its scheduled time by more than 24 hours, so it wasn't published. Reschedule it or publish it now.",
    );
  }
  if (target.post.status === "SCHEDULED") {
    await prisma.post.update({ where: { id: target.post.id }, data: { status: "PUBLISHING" } });
  }

  if (account.status !== "ACTIVE" || !account.token) {
    return fail(target.id, target.post.id, target.attempts, startedAt, "ACCOUNT_NOT_CONNECTED", "This account needs to be reconnected.");
  }

  const adapter = getAdapter(account.platform);
  try {
    const result = await adapter.publish({
      accessToken: decryptToken(account.token.accessTokenEnc),
      accountExternalId: account.externalId,
      request: {
        format: target.format,
        caption: target.captionOverride ?? target.post.caption,
        media: target.post.media.map(({ mediaAsset: m }) => ({
          type: m.type,
          url: deliveryUrl(m),
          format: m.format,
          bytes: m.bytes,
          width: m.width,
          height: m.height,
          durationSec: m.durationSec,
        })),
      },
      state,
      startedAt: firstStartedAt,
      saveState: async (next) => {
        Object.assign(state, next);
        await prisma.postTarget.update({
          where: { id: target.id },
          data: { platformState: { ...state } as Prisma.InputJsonObject },
        });
      },
    });

    if (result.kind === "waiting") {
      const waitingSince = typeof state._waitingSince === "string" ? new Date(state._waitingSince) : now;
      if (now.getTime() - waitingSince.getTime() > MAX_PROCESSING_WAIT_MS) {
        return fail(target.id, target.post.id, target.attempts, startedAt, "PROCESSING_TIMEOUT", "The platform took too long to process the media.");
      }
      await prisma.postTarget.update({
        where: { id: target.id },
        data: {
          status: "WAITING_FOR_MEDIA",
          nextAttemptAt: new Date(now.getTime() + result.retryAfterMs),
          lockedUntil: null,
          platformState: { ...state, _waitingSince: waitingSince.toISOString() } as Prisma.InputJsonObject,
        },
      });
      await logAttempt(target.id, target.attempts, "waiting", startedAt);
      return "waiting";
    }

    await prisma.postTarget.update({
      where: { id: target.id },
      data: {
        status: "PUBLISHED",
        externalPostId: result.externalPostId ?? null,
        permalink: result.permalink ?? null,
        publishedAt: new Date(),
        nextAttemptAt: null,
        lockedUntil: null,
        lastError: null,
        lastErrorCode: null,
      },
    });
    await logAttempt(target.id, target.attempts + 1, "published", startedAt);
    await refreshPostStatus(target.post.id);
    return "published";
  } catch (err) {
    const pe = err instanceof PlatformApiError ? err : null;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const code = pe?.code ?? "INTERNAL_ERROR";

    if (pe?.code === "INVALID_TOKEN") {
      await prisma.$transaction(async (tx) => {
        await tx.socialAccount.update({ where: { id: account.id }, data: { status: "NEEDS_REAUTH" } });
        await audit(
          { action: "social_account.token_rejected", workspaceId: account.workspaceId, targetType: "social_account", targetId: account.id, metadata: { reason: message } },
          tx,
        );
      });
      return fail(
        target.id,
        target.post.id,
        target.attempts,
        startedAt,
        "TOKEN_INVALID",
        `${adapter.capabilities.displayName} rejected this account's access. Reconnect it, then retry.`,
      );
    }

    // Unknown errors (bugs, database blips) are retried like temporary platform errors.
    const retryable = pe ? pe.retryable : true;
    const attempts = target.attempts + 1;
    if (!retryable || attempts >= MAX_ATTEMPTS) {
      return fail(target.id, target.post.id, target.attempts, startedAt, code, message);
    }
    await prisma.postTarget.update({
      where: { id: target.id },
      data: {
        status: "QUEUED",
        attempts,
        nextAttemptAt: new Date(now.getTime() + RETRY_BACKOFF_MS[attempts - 1]!),
        lockedUntil: null,
        lastErrorCode: code,
        lastError: message,
      },
    });
    await logAttempt(target.id, attempts, "retry_scheduled", startedAt, code, message);
    return "retry_scheduled";
  }
}

async function fail(targetId: string, postId: string, attemptsSoFar: number, startedAt: Date, code: string, message: string): Promise<Outcome> {
  await prisma.postTarget.update({
    where: { id: targetId },
    data: { status: "FAILED", attempts: attemptsSoFar + 1, nextAttemptAt: null, lockedUntil: null, lastErrorCode: code, lastError: message },
  });
  await logAttempt(targetId, attemptsSoFar + 1, "failed", startedAt, code, message);
  await refreshPostStatus(postId);
  return "failed";
}

function logAttempt(postTargetId: string, attempt: number, outcome: string, startedAt: Date, errorCode?: string, errorMessage?: string) {
  return prisma.publishAttempt.create({
    data: { postTargetId, attempt, outcome, errorCode, errorMessage, startedAt, finishedAt: new Date() },
  });
}

/** Summarises a post's targets into the post's status. */
export function summarizePostStatus(statuses: TargetStatus[]): PostStatus {
  if (statuses.length > 0 && statuses.every((s) => s === "SCHEDULED")) return "SCHEDULED";
  if (statuses.some((s) => s === "SCHEDULED" || s === "QUEUED" || s === "PUBLISHING" || s === "WAITING_FOR_MEDIA")) return "PUBLISHING";
  const live = statuses.filter((s) => s !== "CANCELLED");
  if (live.length === 0) return "CANCELLED";
  const published = live.filter((s) => s === "PUBLISHED").length;
  if (published === live.length) return "PUBLISHED";
  return published > 0 ? "PARTIALLY_FAILED" : "FAILED";
}

export async function refreshPostStatus(postId: string) {
  const targets = await prisma.postTarget.findMany({ where: { postId }, select: { status: true } });
  await prisma.post.update({ where: { id: postId }, data: { status: summarizePostStatus(targets.map((t) => t.status)) } });
}

/** One worker tick: claim what's due and publish it. */
export async function runPublishCycle(batchSize = 5) {
  const ids = await claimDueTargets(batchSize);
  const outcomes: Outcome[] = [];
  for (const id of ids) outcomes.push(await processTarget(id));
  return outcomes;
}
