import { prisma } from "../config/database.js";
import { sendScheduledPostWarning } from "./email.service.js";
import { findAtRiskTargets, type TargetRisk } from "./post.service.js";

const WINDOW_MS = 24 * 3_600_000;

const explain = (risk: Exclude<TargetRisk, null>, username: string | null) => {
  const name = username ? `@${username}` : "An account";
  return risk === "ACCOUNT_NEEDS_RECONNECT"
    ? `${name} needs to be reconnected.`
    : `${name}'s access expires before the post time. Reconnect it to renew access.`;
};

/**
 * Warns authors, once per post target, about scheduled posts due in the next 24 hours that will
 * probably fail (account needs reconnecting, or access expires first). Run hourly by the worker.
 */
export async function runPreflightChecks(now = new Date()): Promise<{ warnedPosts: number; targets: number }> {
  const risky = await findAtRiskTargets({ withinMs: WINDOW_MS, now, onlyUnwarned: true });

  // One email per post, listing every account at risk.
  const byPost = new Map<string, typeof risky>();
  for (const r of risky) byPost.set(r.target.post.id, [...(byPost.get(r.target.post.id) ?? []), r]);

  for (const [postId, items] of byPost) {
    const post = items[0]!.target.post;
    if (post.author?.email) {
      await sendScheduledPostWarning(post.author.email, {
        postId,
        caption: post.caption,
        scheduledAt: items[0]!.target.scheduledAt!,
        problems: items.map((i) => explain(i.risk, i.target.socialAccount.username)),
      });
    }
    await prisma.postTarget.updateMany({ where: { id: { in: items.map((i) => i.target.id) } }, data: { preflightWarnedAt: now } });
  }
  return { warnedPosts: byPost.size, targets: risky.length };
}
