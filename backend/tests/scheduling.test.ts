import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { claimDueTargets, processTarget, runPublishCycle, summarizePostStatus } from "../src/jobs/publishQueue.js";
import { testOutbox } from "../src/services/email.service.js";
import { runPreflightChecks } from "../src/services/preflight.service.js";
import { addMedia, auth, connectAccount, createPost, fake, installFakes, signUp, type User } from "./support.js";

const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const hours = (n: number) => minutes(n * 60);

beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces, audit_logs CASCADE");
  testOutbox.length = 0;
  installFakes();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

async function scheduledPost(u: User, at: Date, accounts?: { id: string }[]) {
  const accs = accounts ?? [await connectAccount(u)];
  const img = await addMedia(u);
  const res = await createPost(u, {
    caption: "Launch day",
    mediaIds: [img.id],
    targets: accs.map((a) => ({ socialAccountId: a.id })),
    scheduledAt: at.toISOString(),
  });
  expect(res.status).toBe(201);
  return { postId: res.body.post.id as string, accounts: accs, img };
}

/** Pretends the scheduled time has arrived (moving it `byMs` into the past). */
async function arrive(postId: string, byMs = 1000) {
  const at = new Date(Date.now() - byMs);
  await prisma.postTarget.updateMany({ where: { postId }, data: { scheduledAt: at, nextAttemptAt: at } });
  await prisma.post.update({ where: { id: postId }, data: { scheduledAt: at } });
}

const patch = (u: User, postId: string, body: object) =>
  request(app).patch(`/api/v1/workspaces/${u.workspaceId}/posts/${postId}`).set(auth(u)).send(body);
const statusOf = async (postId: string) => (await prisma.post.findUniqueOrThrow({ where: { id: postId } })).status;

describe("scheduling a post", () => {
  it("accepts a time between 2 minutes and a year ahead", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const img = await addMedia(u);
    const body = (at: Date) => ({ caption: "x", mediaIds: [img.id], targets: [{ socialAccountId: account.id }], scheduledAt: at.toISOString() });

    const tooSoon = await createPost(u, body(minutes(1)));
    expect(tooSoon.status).toBe(400);
    expect(tooSoon.body.error.details).toEqual([{ field: "scheduledAt", message: expect.stringContaining("2 minutes") }]);

    const tooFar = await createPost(u, body(new Date(Date.now() + 366 * 86_400_000)));
    expect(tooFar.body.error.details[0].message).toContain("up to a year");

    const bad = await createPost(u, { ...body(minutes(10)), scheduledAt: "next tuesday" });
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");

    const ok = await createPost(u, body(hours(3)));
    expect(ok.status).toBe(201);
    expect(ok.body.post.status).toBe("SCHEDULED");
    expect(new Date(ok.body.post.scheduledAt).getTime()).toBeCloseTo(hours(3).getTime(), -4);
    expect(ok.body.post.targets[0]).toMatchObject({ status: "SCHEDULED", risk: null });
  });

  it("is not published early, and is published once due", async () => {
    const u = await signUp();
    const { postId } = await scheduledPost(u, hours(2));

    expect(await runPublishCycle()).toEqual([]);
    expect(fake.createCalls).toHaveLength(0);
    expect(await statusOf(postId)).toBe("SCHEDULED");

    await arrive(postId);
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(await statusOf(postId)).toBe("PUBLISHED");
  });

  it("keeps the scheduled time when a publish attempt is retried", async () => {
    const u = await signUp();
    const { postId } = await scheduledPost(u, hours(2));
    await arrive(postId);
    const chosen = (await prisma.postTarget.findFirstOrThrow({ where: { postId } })).scheduledAt!;
    fake.createFailures = [{ status: 503, body: { error: { message: "Service unavailable", code: 2 } } }];

    expect(await runPublishCycle()).toEqual(["retry_scheduled"]);
    const target = await prisma.postTarget.findFirstOrThrow({ where: { postId } });
    expect(target.scheduledAt).toEqual(chosen);
    expect(target.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await statusOf(postId)).toBe("PUBLISHING");
  });

  it("publishes a post up to 24 hours late, but marks it missed after that", async () => {
    const u = await signUp();
    const late = await scheduledPost(u, hours(2));
    await arrive(late.postId, 23 * 3_600_000);
    expect(await runPublishCycle()).toEqual(["published"]);

    // A second user, so the account has the ID the fake Instagram answers for.
    const u2 = await signUp();
    const missed = await scheduledPost(u2, hours(2));
    await arrive(missed.postId, 25 * 3_600_000);
    const createsBefore = fake.createCalls.length;
    expect(await runPublishCycle()).toEqual(["failed"]);
    expect(fake.createCalls.length).toBe(createsBefore); // nothing sent to Instagram
    const target = await prisma.postTarget.findFirstOrThrow({ where: { postId: missed.postId } });
    expect(target).toMatchObject({ status: "FAILED", lastErrorCode: "MISSED_SCHEDULE" });
    expect(await statusOf(missed.postId)).toBe("FAILED");

    // Retrying a missed post publishes it now instead of being marked missed again.
    const retry = await request(app).post(`/api/v1/workspaces/${u2.workspaceId}/posts/${missed.postId}/targets/${target.id}/retry`).set(auth(u2));
    expect(retry.status).toBe(200);
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(await statusOf(missed.postId)).toBe("PUBLISHED");
  });
});

describe("editing a scheduled post", () => {
  it("changes caption, media, accounts and time, re-validating everything", async () => {
    const u = await signUp();
    const { postId, accounts } = await scheduledPost(u, hours(2));
    const other = await connectAccount(u, { externalId: "x2", username: "second" });
    const [a, b] = [await addMedia(u), await addMedia(u)];

    const res = await patch(u, postId, {
      caption: "New caption",
      mediaIds: [a.id, b.id],
      targets: [{ socialAccountId: accounts[0]!.id }, { socialAccountId: other.id, captionOverride: "Just for second" }],
      scheduledAt: hours(5).toISOString(),
    });
    expect(res.status).toBe(200);
    expect(res.body.post).toMatchObject({ caption: "New caption", status: "SCHEDULED" });
    expect(res.body.post.media.map((m: { id: string }) => m.id)).toEqual([a.id, b.id]);
    expect(res.body.post.targets).toHaveLength(2);
    expect(res.body.post.targets.every((t: { format: string; status: string }) => t.format === "CAROUSEL" && t.status === "SCHEDULED")).toBe(true);
    const targets = await prisma.postTarget.findMany({ where: { postId } });
    expect(targets.every((t) => Math.abs(t.nextAttemptAt!.getTime() - hours(5).getTime()) < 5000)).toBe(true);

    const invalid = await patch(u, postId, { caption: "#a ".repeat(31) });
    expect(invalid.status).toBe(400);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: postId } })).caption).toBe("New caption");
  });

  it("lets you edit the caption of a post that is due very soon, without moving it", async () => {
    const u = await signUp();
    const { postId } = await scheduledPost(u, hours(2));
    const soon = minutes(1); // inside the 2-minute window
    await prisma.postTarget.updateMany({ where: { postId }, data: { scheduledAt: soon, nextAttemptAt: soon } });
    await prisma.post.update({ where: { id: postId }, data: { scheduledAt: soon } });

    const res = await patch(u, postId, { caption: "Typo fixed" });
    expect(res.status).toBe(200);
    expect(new Date(res.body.post.scheduledAt).getTime()).toBe(soon.getTime());
    const moveTooSoon = await patch(u, postId, { scheduledAt: minutes(1).toISOString() });
    expect(moveTooSoon.status).toBe(400);
  });

  it("publishes immediately when the time is set to null", async () => {
    const u = await signUp();
    const { postId } = await scheduledPost(u, hours(2));
    const res = await patch(u, postId, { scheduledAt: null });
    expect(res.body.post.status).toBe("PUBLISHING");
    expect(res.body.post.targets[0].status).toBe("QUEUED");
    expect(await runPublishCycle()).toEqual(["published"]);
  });

  it("refuses to edit a post that has started publishing", async () => {
    const u = await signUp();
    const { postId } = await scheduledPost(u, hours(2));
    await arrive(postId);
    await claimDueTargets(10); // the worker has it now
    const res = await patch(u, postId, { caption: "too late" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("POST_LOCKED");
  });

  it("never interleaves with the worker: an edit holding the lock makes the worker skip the post", async () => {
    const u = await signUp();
    const { postId } = await scheduledPost(u, hours(2));
    await arrive(postId);

    // Hold the same row lock an edit takes, and try to claim meanwhile.
    let claimedDuringEdit: string[] = [];
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM post_targets WHERE post_id = ${postId}::uuid FOR UPDATE`;
      claimedDuringEdit = await claimDueTargets(10);
    });
    expect(claimedDuringEdit).toEqual([]);

    const afterEdit = await claimDueTargets(10);
    expect(afterEdit).toHaveLength(1);
    expect(await processTarget(afterEdit[0]!)).toBe("published");
  });
});

describe("cancelling and deleting", () => {
  it("cancels a scheduled post so it is never published", async () => {
    const u = await signUp();
    const { postId } = await scheduledPost(u, hours(2));
    const res = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/posts/${postId}/cancel`).set(auth(u));
    expect(res.status).toBe(200);
    expect(res.body.post.status).toBe("CANCELLED");

    await arrive(postId);
    await prisma.postTarget.updateMany({ where: { postId }, data: { status: "CANCELLED" } }); // arrive() doesn't touch status
    expect(await runPublishCycle()).toEqual([]);
    expect(fake.createCalls).toHaveLength(0);

    const again = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/posts/${postId}/cancel`).set(auth(u));
    expect(again.status).toBe(409);
  });

  it("deletes unpublished posts, but not published ones", async () => {
    const u = await signUp();
    const scheduled = await scheduledPost(u, hours(2));
    const del = await request(app).delete(`/api/v1/workspaces/${u.workspaceId}/posts/${scheduled.postId}`).set(auth(u));
    expect(del.status).toBe(204);
    expect(await prisma.post.count({ where: { id: scheduled.postId } })).toBe(0);

    const published = await scheduledPost(u, hours(2), [await connectAccount(u, { externalId: "x2", username: "b" })]);
    await arrive(published.postId);
    await runPublishCycle();
    const refused = await request(app).delete(`/api/v1/workspaces/${u.workspaceId}/posts/${published.postId}`).set(auth(u));
    expect(refused.status).toBe(409);
  });

  it("hides other workspaces' posts from edit, cancel and delete", async () => {
    const owner = await signUp();
    const { postId } = await scheduledPost(owner, hours(2));
    const stranger = await signUp();
    const base = `/api/v1/workspaces/${stranger.workspaceId}/posts/${postId}`;
    expect((await request(app).patch(base).set(auth(stranger)).send({ caption: "x" })).status).toBe(404);
    expect((await request(app).post(`${base}/cancel`).set(auth(stranger))).status).toBe(404);
    expect((await request(app).delete(base).set(auth(stranger))).status).toBe(404);
  });
});

describe("listing for the calendar", () => {
  it("filters by date range (scheduled time, or creation time for immediate posts) and status", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    await scheduledPost(u, hours(2), [account]);
    const later = await scheduledPost(u, hours(24 * 10), [account]);
    const img = await addMedia(u);
    await createPost(u, { caption: "now", mediaIds: [img.id], targets: [{ socialAccountId: account.id }] });

    const list = (q: string) => request(app).get(`/api/v1/workspaces/${u.workspaceId}/posts?${q}`).set(auth(u));
    const week = await list(`from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${hours(24 * 7).toISOString()}`);
    expect(week.body.posts).toHaveLength(2); // the 2 h one and the immediate one, not the one in 10 days

    const scheduled = await list("status=SCHEDULED");
    expect(scheduled.body.posts.map((p: { id: string }) => p.id).at(-1)).toBe(later.postId); // soonest first
    expect(scheduled.body.posts).toHaveLength(2);

    const bad = await list("status=NOPE");
    expect(bad.status).toBe(400);
  });
});

describe("pre-flight warnings", () => {
  it("warns the author once about scheduled posts in the next 24 h that will probably fail", async () => {
    const u = await signUp();
    const stale = await connectAccount(u, { username: "stale" });
    const expiring = await connectAccount(u, { externalId: "x2", username: "expiring" });
    const fine = await connectAccount(u, { externalId: "x3", username: "fine" });
    const { postId } = await scheduledPost(u, hours(6), [stale, expiring, fine]);
    await scheduledPost(u, hours(48), [stale]); // outside the window

    await prisma.socialAccount.update({ where: { id: stale.id }, data: { status: "NEEDS_REAUTH" } });
    await prisma.oAuthToken.update({ where: { socialAccountId: expiring.id }, data: { expiresAt: hours(3) } });

    const atRisk = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/posts/at-risk`).set(auth(u));
    expect(atRisk.body.atRisk.map((r: { account: { username: string }; risk: string }) => [r.account.username, r.risk]).sort()).toEqual([
      ["expiring", "ACCESS_EXPIRES_BEFORE_POST"],
      ["stale", "ACCOUNT_NEEDS_RECONNECT"],
    ]);

    const warnings = () => testOutbox.filter((e) => e.subject === "A scheduled post needs your attention");
    expect(await runPreflightChecks()).toEqual({ warnedPosts: 1, targets: 2 });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]!.text).toContain("@stale needs to be reconnected");
    expect(warnings()[0]!.text).toContain("@expiring's access expires before the post time");
    expect(warnings()[0]!.text).toContain(`/posts/${postId}`);

    expect(await runPreflightChecks()).toEqual({ warnedPosts: 0, targets: 0 });
    expect(warnings()).toHaveLength(1);
  });
});

describe("post status summary", () => {
  it("summarises target statuses", () => {
    expect(summarizePostStatus(["SCHEDULED", "SCHEDULED"])).toBe("SCHEDULED");
    expect(summarizePostStatus(["SCHEDULED", "PUBLISHING"])).toBe("PUBLISHING");
    expect(summarizePostStatus(["PUBLISHED", "CANCELLED"])).toBe("PUBLISHED");
    expect(summarizePostStatus(["PUBLISHED", "FAILED"])).toBe("PARTIALLY_FAILED");
    expect(summarizePostStatus(["CANCELLED", "CANCELLED"])).toBe("CANCELLED");
    expect(summarizePostStatus(["FAILED", "CANCELLED"])).toBe("FAILED");
  });
});
