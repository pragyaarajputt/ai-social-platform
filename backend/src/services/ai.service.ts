import { z } from "zod";
import { askClaude, isAiConfigured, type ClaudeRequest } from "../ai/claude.js";
import { costMicros } from "../ai/pricing.js";
import { captionsPrompt, hashtagsPrompt, PROMPT_VERSIONS, rewritePrompt, systemBlocks } from "../ai/prompts.js";
import { env } from "../config/env.js";
import { prisma } from "../config/database.js";
import type { AiFeature, Prisma } from "../generated/prisma/client.js";
import { instagramCapabilities as ig } from "../integrations/instagram/capabilities.js";
import type { CaptionsInput, FeedbackInput, HashtagsInput, RewriteInput } from "../schemas/ai.schemas.js";
import { aiPreviewUrl } from "../storage/cloudinary.js";
import { AppError } from "../utils/AppError.js";
import { getBrandVoice } from "./brandVoice.service.js";

// AI writing tools. Every request is checked against the workspace's daily limit and the server's
// daily spend cap, reserved as a row in ai_requests before Claude is called, and then completed with
// its token usage, estimated cost and output. Suggestions are only returned; nothing is saved to a
// post until the user applies one.

interface Ctx {
  workspaceId: string;
  userId: string;
}

/** At most this many photos are shown to Claude per request; more rarely helps and costs more. */
const MAX_IMAGES = 4;

const startOfUtcDay = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const startOfNextUtcDay = (now = new Date()) => new Date(startOfUtcDay(now).getTime() + 86_400_000);

/** Requests that count against the daily limit: everything that was (or is being) sent to Claude. */
const countedToday = (workspaceId: string, since: Date): Prisma.AiRequestWhereInput => ({
  workspaceId,
  createdAt: { gte: since },
  status: { notIn: ["QUOTA_EXCEEDED", "SPEND_CAP_REACHED"] },
});

// ─── Limits ─────────────────────────────────────────────────────────────────

/**
 * Reserves one request against the workspace's daily limit. A transaction-scoped advisory lock per
 * workspace makes the count-then-insert atomic, so parallel requests can't overshoot the limit.
 */
async function reserve(ctx: Ctx, feature: AiFeature, promptVersion: string): Promise<string> {
  const since = startOfUtcDay();
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-quota:${ctx.workspaceId}`}))`;
    const row = { workspaceId: ctx.workspaceId, userId: ctx.userId, feature, promptVersion, model: env.ai.model };

    const used = await tx.aiRequest.count({ where: countedToday(ctx.workspaceId, since) });
    if (used >= env.ai.dailyRequestsPerWorkspace) {
      await tx.aiRequest.create({ data: { ...row, status: "QUOTA_EXCEEDED", completedAt: new Date() } });
      return "QUOTA_EXCEEDED" as const;
    }
    const spent = await tx.aiRequest.aggregate({ _sum: { costMicros: true }, where: { createdAt: { gte: since } } });
    if ((spent._sum.costMicros ?? 0) >= env.ai.dailySpendCapMicros) {
      await tx.aiRequest.create({ data: { ...row, status: "SPEND_CAP_REACHED", completedAt: new Date() } });
      return "SPEND_CAP_REACHED" as const;
    }
    return (await tx.aiRequest.create({ data: row })).id;
  });

  if (outcome === "QUOTA_EXCEEDED") {
    throw new AppError(429, "AI_DAILY_LIMIT", `This workspace has used all ${env.ai.dailyRequestsPerWorkspace} AI requests for today. The limit resets at midnight UTC.`);
  }
  if (outcome === "SPEND_CAP_REACHED") {
    console.warn(`AI daily spend cap reached ($${env.ai.dailySpendCapMicros / 1_000_000}); AI requests are paused until midnight UTC.`);
    throw new AppError(503, "AI_PAUSED", "AI writing is paused for today. Try again tomorrow.");
  }
  return outcome;
}

/**
 * Runs one request: reserve → Claude → check the output → record usage and the result.
 * `finish` turns Claude's parsed output into what the user gets, or null if it isn't usable.
 */
async function run<T, R>(ctx: Ctx, feature: AiFeature, promptVersion: string, request: Omit<ClaudeRequest<T>, "userId">, finish: (output: T) => R | null) {
  if (!isAiConfigured()) throw new AppError(501, "NOT_CONFIGURED", "AI writing isn't set up on this server yet");
  const requestId = await reserve(ctx, feature, promptVersion);
  const started = Date.now();
  const complete = (data: Prisma.AiRequestUpdateInput) =>
    prisma.aiRequest.update({ where: { id: requestId }, data: { ...data, latencyMs: Date.now() - started, completedAt: new Date() } });

  let result;
  try {
    result = await askClaude({ ...request, userId: ctx.userId });
  } catch (err) {
    await complete({ status: "ERROR", errorCode: err instanceof AppError ? err.code : "INTERNAL_ERROR" });
    throw err;
  }

  const usage = { model: result.model, ...result.usage, costMicros: costMicros(result.model, result.usage) };
  if (result.kind === "refused") {
    await complete({ ...usage, status: "REFUSED" });
    throw new AppError(422, "AI_REFUSED", "AI couldn't help with this one. Try rewording it.");
  }
  const value = result.kind === "ok" ? finish(result.output) : null;
  if (value === null) {
    await complete({ ...usage, status: "ERROR", errorCode: result.kind === "bad_output" ? `BAD_OUTPUT:${result.reason}`.slice(0, 40) : "BAD_OUTPUT:rules" });
    throw new AppError(502, "AI_BAD_OUTPUT", "AI came back with something unusable. Please try again.");
  }
  await complete({ ...usage, status: "OK", output: value as Prisma.InputJsonValue });
  return { requestId, ...value };
}

/** Photos to show Claude, as small previews. Only media from this workspace. */
async function previewUrls(workspaceId: string, mediaIds: string[]) {
  if (mediaIds.length === 0) return { imageUrls: [], hasVideo: false };
  const assets = await prisma.mediaAsset.findMany({ where: { id: { in: mediaIds }, workspaceId } });
  if (assets.length !== new Set(mediaIds).size) throw new AppError(400, "MEDIA_NOT_FOUND", "Some media no longer exists. Remove it and try again.");
  const byId = new Map(assets.map((a) => [a.id, a]));
  const shown = mediaIds.slice(0, MAX_IMAGES).map((id) => byId.get(id)!);
  return { imageUrls: shown.map(aiPreviewUrl), hasVideo: shown.some((a) => a.type === "VIDEO") };
}

// ─── Features ───────────────────────────────────────────────────────────────

const CaptionsOutput = z.object({ captions: z.array(z.object({ text: z.string() })) });
const HashtagsOutput = z.object({ hashtags: z.array(z.object({ tag: z.string(), kind: z.enum(["broad", "niche"]) })) });
const RewriteOutput = z.object({ text: z.string() });

export async function generateCaptions(ctx: Ctx, input: CaptionsInput) {
  const [media, voice] = await Promise.all([previewUrls(ctx.workspaceId, input.mediaIds), getBrandVoice(ctx.workspaceId)]);
  return run(
    ctx,
    "CAPTIONS",
    PROMPT_VERSIONS.captions,
    { system: systemBlocks(voice), content: captionsPrompt({ idea: input.idea || undefined, tone: input.tone, ...media }), schema: CaptionsOutput },
    (out) => {
      const captions = out.captions.map((c) => c.text.trim()).filter((t) => t.length > 0 && t.length <= ig.captionMaxLength).slice(0, 3);
      return captions.length ? { captions } : null;
    },
  );
}

const HASHTAG = /(?:^|\s)#([\p{L}\p{N}_]+)/gu;
export const hashtagsIn = (text: string) => [...text.matchAll(HASHTAG)].map((m) => m[1]!);

/** A usable hashtag: letters, digits and underscores, with at least one letter (numbers alone don't link). */
function cleanTag(raw: string): string | null {
  const tag = raw.trim().replace(/^#+/, "");
  return /^[\p{L}\p{N}_]{2,100}$/u.test(tag) && /[\p{L}_]/u.test(tag) ? tag : null;
}

export async function suggestHashtags(ctx: Ctx, input: HashtagsInput) {
  const existing = hashtagsIn(input.caption);
  const max = ig.hashtagMax ?? 30;
  const room = max - existing.length;
  if (room <= 0) throw new AppError(400, "HASHTAG_LIMIT", `This caption already has ${existing.length} hashtags; Instagram allows ${max}.`);
  const count = Math.min(15, room);

  const [media, voice] = await Promise.all([previewUrls(ctx.workspaceId, input.mediaIds), getBrandVoice(ctx.workspaceId)]);
  return run(
    ctx,
    "HASHTAGS",
    PROMPT_VERSIONS.hashtags,
    { system: systemBlocks(voice), content: hashtagsPrompt({ caption: input.caption, imageUrls: media.imageUrls, count }), schema: HashtagsOutput },
    (out) => {
      const seen = new Set(existing.map((t) => t.toLowerCase()));
      const hashtags: { tag: string; kind: "broad" | "niche" }[] = [];
      for (const h of out.hashtags) {
        const tag = cleanTag(h.tag);
        if (!tag || seen.has(tag.toLowerCase())) continue;
        seen.add(tag.toLowerCase());
        hashtags.push({ tag, kind: h.kind });
      }
      return hashtags.length ? { hashtags: hashtags.slice(0, count) } : null;
    },
  );
}

export async function rewrite(ctx: Ctx, input: RewriteInput) {
  const voice = await getBrandVoice(ctx.workspaceId);
  return run(
    ctx,
    "REWRITE",
    PROMPT_VERSIONS.rewrite,
    { system: systemBlocks(voice), content: rewritePrompt(input), schema: RewriteOutput },
    (out) => {
      const text = out.text.trim();
      return text.length > 0 && text.length <= ig.captionMaxLength ? { text } : null;
    },
  );
}

// ─── Feedback and usage ─────────────────────────────────────────────────────

export async function recordFeedback(workspaceId: string, requestId: string, input: FeedbackInput) {
  const { count } = await prisma.aiRequest.updateMany({
    where: { id: requestId, workspaceId, status: "OK" },
    data: {
      ...(input.appliedIndex !== undefined && { appliedIndex: input.appliedIndex }),
      ...(input.rating !== undefined && { rating: input.rating }),
    },
  });
  if (count === 0) throw new AppError(404, "AI_REQUEST_NOT_FOUND", "AI request not found");
}

export async function getUsage(workspaceId: string) {
  const since = startOfUtcDay();
  const used = await prisma.aiRequest.count({ where: countedToday(workspaceId, since) });
  return {
    configured: isAiConfigured(),
    model: env.ai.model,
    usedToday: used,
    dailyLimit: env.ai.dailyRequestsPerWorkspace,
    resetsAt: startOfNextUtcDay(),
  };
}
