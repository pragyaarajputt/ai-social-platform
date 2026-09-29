import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { onlineGrid } from "../src/integrations/instagram/insights.js";
import { nextFetchAt, runAnalyticsCollection, utcDay } from "../src/jobs/analytics.js";
import { runPublishCycle } from "../src/jobs/publishQueue.js";
import { engagementRate } from "../src/services/analytics.service.js";
import { addMedia, auth, connectAccount, createPost, fake, installFakes, signUp, targetOf, type User } from "./support.js";

beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces, audit_logs CASCADE");
  installFakes();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

/** Publishes one image post and returns its target (published now, as Instagram media "m1"). */
async function publishOne(u: User) {
  const account = await connectAccount(u);
  const photo = await addMedia(u);
  const res = await createPost(u, { caption: "Hello", mediaIds: [photo.id], targets: [{ socialAccountId: account.id }] });
  expect(await runPublishCycle()).toEqual(["published"]);
  const target = await targetOf(res.body.post.id);
  return { account, target, postId: res.body.post.id as string };
}

const metricsOf = (targetId: string) => prisma.postTargetMetrics.findUnique({ where: { postTargetId: targetId } });
const mediaCalls = () => fake.insights.calls.filter((c) => c.startsWith("media:"));

// ─── Pure helpers ───────────────────────────────────────────────────────────

describe("schedule and helpers", () => {
  it("collects post numbers at 1 h, 6 h, 1 d, 3 d, 7 d, 14 d, 30 d, then weekly, stopping at 90 days", () => {
    const published = new Date("2026-09-01T12:00:00Z");
    expect(nextFetchAt(published, published)).toEqual(at(published, HOUR));
    expect(nextFetchAt(published, at(published, HOUR))).toEqual(at(published, 6 * HOUR));
    // A late run skips the points it missed instead of catching up one by one.
    expect(nextFetchAt(published, at(published, 5 * DAY))).toEqual(at(published, 7 * DAY));
    expect(nextFetchAt(published, at(published, 31 * DAY))).toEqual(at(published, 37 * DAY));
    expect(nextFetchAt(published, at(published, 89 * DAY))).toEqual(at(published, 90 * DAY));
    expect(nextFetchAt(published, at(published, 90 * DAY))).toBeNull();
  });

  it("engagement rate is interactions per account reached, and null without reach", () => {
    expect(engagementRate(42, 1000)).toBe(0.042);
    expect(engagementRate(5, 0)).toBeNull();
    expect(engagementRate(null, 100)).toBeNull();
  });

  it("maps online_followers hours to UTC weekday × hour using each day's end_time", () => {
    // A day ending Monday 2026-09-21 07:00 UTC (midnight Pacific) starts Sunday 07:00 UTC.
    const grid = onlineGrid([
      { end_time: "2026-09-21T07:00:00+0000", value: { "0": 100, "13": 300 } },
      { end_time: "2026-09-28T07:00:00+0000", value: { "0": 200 } },
      { end_time: "not a date", value: { "0": 999 } },
    ])!;
    expect(grid[0]![7]).toBe(150); // Sunday 07:00 UTC, averaged over two Sundays
    expect(grid[0]![20]).toBe(300); // Sunday 20:00 UTC
    expect(grid[1]![7]).toBe(0);
    expect(onlineGrid([{ end_time: "2026-09-21T07:00:00+0000", value: {} }])).toBeNull();
  });
});

// ─── Collecting post numbers ────────────────────────────────────────────────

describe("post metrics collection", () => {
  it("fetches a published post's numbers on schedule, keeps history, and stops after 90 days", async () => {
    const u = await signUp();
    const { target } = await publishOne(u);
    const published = target.publishedAt!;

    // Not due in the first hour.
    await runAnalyticsCollection(at(published, 30 * 60_000));
    expect(await metricsOf(target.id)).toMatchObject({ status: "PENDING", nextFetchAt: at(published, HOUR) });
    expect(mediaCalls()).toEqual([]);

    await runAnalyticsCollection(at(published, HOUR + 60_000));
    expect(await metricsOf(target.id)).toMatchObject({
      status: "OK",
      views: 1200,
      reach: 800,
      likes: 90,
      saves: 15,
      totalInteractions: 124,
      profileVisits: 20,
      // Not a Reel: no watch time.
      avgWatchTimeMs: null,
      fetchCount: 1,
      nextFetchAt: at(published, 6 * HOUR),
    });
    expect(mediaCalls()).toEqual(["media:m1"]);

    // Numbers grow; the next collection updates them and adds a snapshot.
    fake.insights.media.views = 5000;
    await runAnalyticsCollection(at(published, 2 * HOUR));
    expect(mediaCalls()).toHaveLength(1);
    await runAnalyticsCollection(at(published, 6 * HOUR + 60_000));
    expect((await metricsOf(target.id))!.views).toBe(5000);
    expect(await prisma.postMetricSnapshot.count({ where: { postTargetId: target.id } })).toBe(2);

    // Last collection at 90 days; nothing after.
    await runAnalyticsCollection(at(published, 91 * DAY));
    expect((await metricsOf(target.id))!.nextFetchAt).toBeNull();
    await runAnalyticsCollection(at(published, 120 * DAY));
    expect(mediaCalls()).toHaveLength(3);
  });

  it("asks for Reel metrics (watch time) for Reels", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const video = await addMedia(u, { type: "VIDEO", width: 1080, height: 1920 });
    const res = await createPost(u, { caption: "Reel", mediaIds: [video.id], targets: [{ socialAccountId: account.id }] });
    expect(await runPublishCycle()).toEqual(["published"]);
    const target = await targetOf(res.body.post.id);
    await runAnalyticsCollection(at(target.publishedAt!, 2 * HOUR));
    expect(await metricsOf(target.id)).toMatchObject({ avgWatchTimeMs: 6400, profileVisits: null });
  });

  it("marks a post deleted on Instagram as unavailable and stops checking it", async () => {
    const u = await signUp();
    const { target } = await publishOne(u);
    fake.insights.deleted.add("m1");
    await runAnalyticsCollection(at(target.publishedAt!, 2 * HOUR));
    expect(await metricsOf(target.id)).toMatchObject({ status: "UNAVAILABLE", nextFetchAt: null, lastError: "Media does not exist" });
    await runAnalyticsCollection(at(target.publishedAt!, 10 * DAY));
    expect(mediaCalls()).toHaveLength(1);
  });

  it("ignores accounts without the insights permission", async () => {
    const u = await signUp();
    const account = await connectAccount(u, { insightsAllowed: false });
    const photo = await addMedia(u);
    await createPost(u, { caption: "Hi", mediaIds: [photo.id], targets: [{ socialAccountId: account.id }] });
    await runPublishCycle();
    const summary = await runAnalyticsCollection(new Date(Date.now() + 2 * HOUR));
    expect(summary.accounts).toBe(0);
    expect(fake.insights.calls).toEqual([]);
  });
});

// ─── Failures ───────────────────────────────────────────────────────────────

describe("when Instagram refuses", () => {
  it("turns analytics off for the account when the permission was removed, without affecting publishing", async () => {
    const u = await signUp();
    const { account, target } = await publishOne(u);
    fake.insights.error = { status: 400, body: { error: { message: "Application does not have permission for this action", code: 10 } } };
    const summary = await runAnalyticsCollection(at(target.publishedAt!, 2 * HOUR));
    expect(summary.permissionLost).toBe(1);
    const after = await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(after).toMatchObject({ insightsAllowed: false, status: "ACTIVE" });
    expect(await prisma.auditLog.count({ where: { action: "social_account.insights_denied", targetId: account.id } })).toBe(1);
    // Still pending: it's collected once the account is reconnected with the permission.
    expect((await metricsOf(target.id))!.status).toBe("PENDING");
  });

  it("stops the account's run on a rate limit and tries again next run", async () => {
    const u = await signUp();
    const { target } = await publishOne(u);
    fake.insights.error = { status: 400, body: { error: { message: "Application request limit reached", code: 4 } } };
    const summary = await runAnalyticsCollection(at(target.publishedAt!, 2 * HOUR));
    expect(summary.stopped).toBe(1);
    expect(fake.insights.calls).toHaveLength(1);
    expect((await metricsOf(target.id))!.status).toBe("PENDING");

    fake.insights.error = null;
    await runAnalyticsCollection(at(target.publishedAt!, 3 * HOUR));
    expect((await metricsOf(target.id))!.status).toBe("OK");
  });
});

// ─── Account numbers ────────────────────────────────────────────────────────

describe("account collection", () => {
  it("backfills 30 days, samples followers, and fetches when followers are online", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    fake.insights.online = [{ end_time: "2026-09-21T07:00:00+0000", value: { "12": 40 } }];
    const now = new Date("2026-09-25T10:00:00Z");
    await runAnalyticsCollection(now, { callsPerAccount: 200 });

    const rows = await prisma.accountDailyStats.findMany({ where: { socialAccountId: account.id }, orderBy: { date: "asc" } });
    // 30 past days with insights, plus today with only the follower count.
    expect(rows).toHaveLength(31);
    expect(rows[0]!.date.toISOString()).toBe("2026-08-26T00:00:00.000Z");
    expect(rows[29]).toMatchObject({ reach: 500, views: 900, accountsEngaged: 60, totalInteractions: 80, profileLinksTaps: 4, follows: 6, unfollows: 2 });
    expect(rows[30]).toMatchObject({ date: utcDay(now), followers: 1520, reach: null, insightsFetchedAt: null });
    // Each day is requested as exactly that UTC day.
    expect(fake.insights.calls).toContain(`account:main:${Date.parse("2026-09-24T00:00:00Z") / 1000}`);

    const audience = await prisma.accountAudience.findUniqueOrThrow({ where: { socialAccountId: account.id } });
    expect((audience.onlineGrid as number[][])[0]![19]).toBe(40);

    // Straight away again: nothing to do.
    fake.insights.calls = [];
    await runAnalyticsCollection(new Date(now.getTime() + 60_000), { callsPerAccount: 200 });
    expect(fake.insights.calls).toEqual([]);

    // A day later: only the days still settling (up to 3 days old) and today's followers.
    await runAnalyticsCollection(new Date(now.getTime() + DAY), { callsPerAccount: 200 });
    const mainDays = fake.insights.calls.filter((c) => c.startsWith("account:main"));
    expect(mainDays.length).toBeGreaterThan(0);
    expect(mainDays.length).toBeLessThanOrEqual(4);
    expect(fake.insights.calls).toContain("followers");
    expect(fake.insights.calls).toContain("online");
  });

  it("spreads a backfill over several runs with a per-account call budget", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const now = new Date("2026-09-25T10:00:00Z");
    await runAnalyticsCollection(now, { callsPerAccount: 9 });
    // 1 call for followers, then 2 per day.
    expect(await prisma.accountDailyStats.count({ where: { socialAccountId: account.id, insightsFetchedAt: { not: null } } })).toBe(4);
    await runAnalyticsCollection(new Date(now.getTime() + HOUR), { callsPerAccount: 9 });
    expect(await prisma.accountDailyStats.count({ where: { socialAccountId: account.id, insightsFetchedAt: { not: null } } })).toBe(8);
  });

  it("stores no audience grid for small accounts", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    fake.insights.online = [];
    await runAnalyticsCollection(new Date(), { callsPerAccount: 200 });
    expect((await prisma.accountAudience.findUniqueOrThrow({ where: { socialAccountId: account.id } })).onlineGrid).toBeNull();
  });
});

// ─── API ────────────────────────────────────────────────────────────────────

describe("analytics API", () => {
  async function seedDays(accountId: string, from: Date, days: number, values: (i: number) => object) {
    for (let i = 0; i < days; i++) {
      await prisma.accountDailyStats.create({
        data: { socialAccountId: accountId, date: new Date(from.getTime() + i * DAY), insightsFetchedAt: new Date(), ...values(i) },
      });
    }
  }

  it("summarizes a range against the previous one, with a daily series and follower change", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const today = utcDay(new Date());
    // Previous 7 days: reach 100/day; current 7 days: reach 200/day, one day missing.
    await seedDays(account.id, new Date(today.getTime() - 14 * DAY), 7, () => ({ reach: 100, totalInteractions: 5, followers: 1000 }));
    await seedDays(account.id, new Date(today.getTime() - 7 * DAY), 6, (i) => ({ reach: 200, views: 300, totalInteractions: 10, followers: 1000 + i * 10 }));
    await prisma.accountDailyStats.create({ data: { socialAccountId: account.id, date: today, followers: 1100 } });

    const res = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/analytics/overview?days=7`).set(auth(u));
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ id: account.id, username: "brand", insightsAllowed: true });
    expect(res.body.totals).toMatchObject({ reach: 1200, views: 1800, totalInteractions: 60, likes: null, engagementRate: 0.05 });
    expect(res.body.previousTotals).toMatchObject({ reach: 700, totalInteractions: 35, engagementRate: 0.05 });
    // 1100 today vs 1000 at the start of the range.
    expect(res.body.followers).toEqual({ current: 1100, change: 100 });
    expect(res.body.series).toHaveLength(7);
    expect(res.body.series[0]).toMatchObject({ date: new Date(today.getTime() - 7 * DAY).toISOString().slice(0, 10), reach: 200 });
    expect(res.body.series[6]).toMatchObject({ reach: null, views: null });
    expect(res.body.daysWithData).toBe(6);
  });

  it("rejects other workspaces' accounts and invalid ranges", async () => {
    const u = await signUp();
    const other = await signUp();
    const theirs = await connectAccount(other);
    const res = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/analytics/overview?accountId=${theirs.id}`).set(auth(u));
    expect(res.status).toBe(404);
    expect((await request(app).get(`/api/v1/workspaces/${u.workspaceId}/analytics/overview?days=5`).set(auth(u))).status).toBe(400);
    expect((await request(app).get(`/api/v1/workspaces/${other.workspaceId}/analytics/overview`).set(auth(u))).status).toBe(404);
    // No accounts yet: an empty answer, not an error.
    expect((await request(app).get(`/api/v1/workspaces/${u.workspaceId}/analytics/overview`).set(auth(u))).body).toEqual({ accounts: [], account: null, withoutAnalytics: [] });
  });

  it("lists published posts with their numbers, sorted, posts without numbers last", async () => {
    const u = await signUp();
    const { target, postId } = await publishOne(u);
    await runAnalyticsCollection(at(target.publishedAt!, 2 * HOUR));

    // A second post without numbers yet.
    const photo = await addMedia(u);
    await createPost(u, { caption: "Newer", mediaIds: [photo.id], targets: [{ socialAccountId: target.socialAccountId }] });
    await runPublishCycle();

    const res = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/analytics/posts?sort=engagement`).set(auth(u));
    expect(res.status).toBe(200);
    expect(res.body.posts).toHaveLength(2);
    expect(res.body.posts[0]).toMatchObject({ postId, caption: "Hello", format: "IMAGE", views: 1200, metricsStatus: "OK", engagementRate: 124 / 800 });
    expect(res.body.posts[0].thumbnailUrl).toMatch(/c_fill,w_320/);
    expect(res.body.posts[1]).toMatchObject({ caption: "Newer", metricsStatus: "PENDING", views: null });

    const recent = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/analytics/posts?sort=recent`).set(auth(u));
    expect(recent.body.posts[0].caption).toBe("Newer");

    // The post page shows the same numbers.
    const post = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/posts/${postId}`).set(auth(u));
    expect(post.body.post.targets[0].metrics).toMatchObject({ status: "OK", views: 1200, reach: 800 });
  });

  it("returns the best-times grid", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const res0 = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/analytics/best-times`).set(auth(u));
    expect(res0.body).toMatchObject({ account: { id: account.id }, grid: null, fetchedAt: null });

    fake.insights.online = [{ end_time: "2026-09-21T07:00:00+0000", value: { "12": 40 } }];
    await runAnalyticsCollection(new Date(), { callsPerAccount: 200 });
    const res = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/analytics/best-times?accountId=${account.id}`).set(auth(u));
    expect(res.body.grid).toHaveLength(7);
    expect(res.body.grid[0][19]).toBe(40);
  });
});
