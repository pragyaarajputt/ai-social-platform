import { createHmac } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { runAnalyticsCollection } from "../src/jobs/analytics.js";
import { processTarget, runPublishCycle } from "../src/jobs/publishQueue.js";
import { decryptToken } from "../src/utils/tokenCrypto.js";
import { addMedia, auth, connectAccount, connectPage, createPost, fastForward, fb, FB_PAGE, FB_USER, installFakes, signUp, targetOf, type User } from "./support.js";

beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces, audit_logs CASCADE");
  installFakes();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

const HOUR = 3_600_000;
const feedCalls = () => fb.calls.filter((c) => c === `POST ${FB_PAGE}/feed`);

// ─── Connecting ─────────────────────────────────────────────────────────────

describe("connecting Facebook Pages", () => {
  async function startConnect(u: User) {
    const res = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/social-accounts/facebook/connect`).set(auth(u));
    expect(res.status).toBe(200);
    return new URL(res.body.authorizationUrl);
  }
  const callback = (query: Record<string, string>) => request(app).get(`/api/v1/integrations/facebook/callback?${new URLSearchParams(query)}`);

  it("asks for the Page permissions, or uses the login configuration when there is one", async () => {
    const u = await signUp();
    const url = await startConnect(u);
    expect(`${url.origin}${url.pathname}`).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("test-facebook-app-id");
    expect(url.searchParams.get("redirect_uri")).toBe(env.facebook!.redirectUri);
    expect(url.searchParams.get("scope")).toBe("pages_show_list,pages_manage_posts,pages_read_engagement,read_insights,business_management");

    env.facebook!.configId = "cfg-123";
    try {
      const withConfig = await startConnect(u);
      expect(withConfig.searchParams.get("config_id")).toBe("cfg-123");
      expect(withConfig.searchParams.has("scope")).toBe(false);
    } finally {
      env.facebook!.configId = undefined;
    }
  });

  it("connects every granted Page the user can post to, each with its own Page token", async () => {
    const u = await signUp();
    fb.pages.push(
      { id: "1000000000000002", name: "Second Page", access_token: "fb-page-token", tasks: ["CREATE_CONTENT", "MANAGE"] },
      // Only allowed to see insights: can't be published to, so not connected.
      { id: "1000000000000003", name: "Analyst Only", access_token: "fb-page-token", tasks: ["ANALYZE"] },
    );
    const state = (await startConnect(u)).searchParams.get("state")!;
    const res = await callback({ code: "fb-good-code", state });
    expect(res.headers.location).toBe(`${env.appUrl}/accounts?connected=facebook&count=2`);

    const accounts = await prisma.socialAccount.findMany({ where: { workspaceId: u.workspaceId }, include: { token: true }, orderBy: { externalId: "asc" } });
    expect(accounts.map((a) => [a.externalId, a.username, a.accountType, a.appScopedId, a.insightsAllowed])).toEqual([
      [FB_PAGE, "punecafe", "PAGE", FB_USER, true],
      // No username: the Page name is shown instead.
      ["1000000000000002", "Second Page", "PAGE", FB_USER, true],
    ]);
    expect(decryptToken(accounts[0]!.token!.accessTokenEnc)).toBe("fb-page-token");
    // Page tokens don't expire, so the refresh job never touches them.
    expect(accounts[0]!.token!.expiresAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "social_account.connected" } })).toBe(2);

    // Reconnecting updates the same accounts.
    const again = await callback({ code: "fb-good-code", state: (await startConnect(u)).searchParams.get("state")! });
    expect(again.headers.location).toContain("count=2");
    expect(await prisma.socialAccount.count({ where: { workspaceId: u.workspaceId } })).toBe(2);
  });

  it("reports when no Page was chosen or can be posted to, and turns analytics off without read_insights", async () => {
    const u = await signUp();
    fb.pages[0]!.tasks = ["ANALYZE"];
    const res = await callback({ code: "fb-good-code", state: (await startConnect(u)).searchParams.get("state")! });
    expect(res.headers.location).toBe(`${env.appUrl}/accounts?error=no_accounts&platform=facebook`);

    fb.pages[0]!.tasks = ["CREATE_CONTENT"];
    fb.permissions = fb.permissions.filter((p) => p !== "read_insights");
    await callback({ code: "fb-good-code", state: (await startConnect(u)).searchParams.get("state")! });
    expect((await prisma.socialAccount.findFirstOrThrow({ where: { workspaceId: u.workspaceId } })).insightsAllowed).toBe(false);
  });

  it("revokes the user's Pages when they remove the app (Facebook's own signed request)", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const signed = (secret: string) => {
      const body = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: FB_USER, issued_at: 1 })).toString("base64url");
      return `${createHmac("sha256", secret).update(body).digest("base64url")}.${body}`;
    };
    // Signed with the Instagram secret: rejected.
    const wrong = await request(app).post("/api/v1/integrations/facebook/deauthorize").type("form").send({ signed_request: signed(env.instagram!.appSecret) });
    expect(wrong.status).toBe(400);
    const ok = await request(app).post("/api/v1/integrations/facebook/deauthorize").type("form").send({ signed_request: signed(env.facebook!.appSecret) });
    expect(ok.status).toBe(200);
    expect(await prisma.socialAccount.findUniqueOrThrow({ where: { id: page.id }, include: { token: true } })).toMatchObject({ status: "REVOKED", token: null });
  });
});

// ─── Publishing ─────────────────────────────────────────────────────────────

describe("publishing to a Page", () => {
  it("publishes a text-only post, which Instagram can't take", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const ig = await connectAccount(u);

    const both = await createPost(u, { caption: "Open late tonight!", targets: [{ socialAccountId: page.id }, { socialAccountId: ig.id }] });
    expect(both.status).toBe(400);
    expect(both.body.error.details).toEqual([{ field: "targets.1", message: "@brand: Instagram posts need at least one photo or video." }]);

    const res = await createPost(u, { caption: "Open late tonight!", targets: [{ socialAccountId: page.id }] });
    expect(res.status).toBe(201);
    expect(res.body.post.targets[0]).toMatchObject({ format: "TEXT", account: { platform: "FACEBOOK", username: "punecafe" } });
    expect(await runPublishCycle()).toEqual(["published"]);
    const target = await targetOf(res.body.post.id);
    expect(target).toMatchObject({ status: "PUBLISHED", externalPostId: fb.posts[0]!.id, permalink: `https://www.facebook.com/${fb.posts[0]!.id}` });
    expect(fb.posts[0]!.message).toBe("Open late tonight!");
  });

  it("creates once and publishes to both: a photo post on Facebook and an image on Instagram", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const ig = await connectAccount(u);
    const photo = await addMedia(u);
    const res = await createPost(u, {
      caption: "Autumn menu",
      mediaIds: [photo.id],
      targets: [{ socialAccountId: page.id, captionOverride: "Autumn menu. A longer text for Facebook." }, { socialAccountId: ig.id }],
    });
    expect(res.status).toBe(201);
    expect((await runPublishCycle()).sort()).toEqual(["published", "published"]);
    const [fbPhoto] = [...fb.photos.values()];
    expect(fbPhoto).toMatchObject({ published: true, caption: "Autumn menu. A longer text for Facebook." });
    expect(fbPhoto!.url).toMatch(/\/image\/upload\/c_limit,w_1440,q_auto\/.+\.jpg$/);
    const post = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/posts/${res.body.post.id}`).set(auth(u));
    expect(post.body.post.status).toBe("PUBLISHED");
  });

  it("publishes several photos as one multi-photo post", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const photos = [await addMedia(u), await addMedia(u), await addMedia(u)];
    const res = await createPost(u, { caption: "Three new cakes", mediaIds: photos.map((p) => p.id), targets: [{ socialAccountId: page.id }] });
    expect(res.body.post.targets[0].format).toBe("CAROUSEL");
    await runPublishCycle();
    expect([...fb.photos.values()].every((p) => !p.published)).toBe(true);
    expect(fb.posts).toHaveLength(1);
    expect(fb.posts[0]!.attached).toEqual([...fb.photos.keys()]);
    expect(fb.posts[0]!.message).toBe("Three new cakes");
  });

  it("rejects photos and a video together for Facebook", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const res = await createPost(u, { caption: "Mix", mediaIds: [(await addMedia(u)).id, (await addMedia(u, { type: "VIDEO" })).id], targets: [{ socialAccountId: page.id }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.error.details)).toContain("several photos or one video");
  });

  it("posts a landscape video as a video, waiting while Facebook processes it", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const video = await addMedia(u, { type: "VIDEO", width: 1920, height: 1080, durationSec: 120 });
    fb.videoStatuses = ["processing", "ready"];
    const res = await createPost(u, { caption: "Behind the scenes", mediaIds: [video.id], targets: [{ socialAccountId: page.id }] });
    expect(res.body.post.targets[0].format).toBe("VIDEO");

    expect(await runPublishCycle()).toEqual(["waiting"]);
    expect(fb.calls).toContain(`POST graph-video.facebook.com/${FB_PAGE}/videos`);
    await fastForward();
    expect(await runPublishCycle()).toEqual(["published"]);
    const target = await targetOf(res.body.post.id);
    const [videoId] = [...fb.videos.keys()];
    expect(target).toMatchObject({ status: "PUBLISHED", externalPostId: fb.videos.get(videoId!)!.postId, permalink: `https://www.facebook.com/watch/${videoId}` });
    // Uploaded once, even though it was checked twice.
    expect(fb.calls.filter((c) => c.endsWith("/videos"))).toHaveLength(1);
  });

  it("posts a short vertical video as a Reel: start, upload from our URL, finish, then wait until published", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const video = await addMedia(u, { type: "VIDEO", width: 1080, height: 1920, durationSec: 30 });
    fb.videoStatuses = ["processing", "ready"];
    const res = await createPost(u, { caption: "Latte art", mediaIds: [video.id], targets: [{ socialAccountId: page.id }] });
    expect(res.body.post.targets[0].format).toBe("REEL");

    expect(await runPublishCycle()).toEqual(["waiting"]);
    expect(fb.ruploadHeaders[0]).toMatchObject({ Authorization: "OAuth fb-page-token", file_url: video.secureUrl });
    await fastForward();
    expect(await runPublishCycle()).toEqual(["published"]);
    const [reel] = [...fb.videos.values()];
    expect(reel).toMatchObject({ kind: "reel", uploaded: true, finished: true, description: "Latte art" });
    expect((await targetOf(res.body.post.id)).permalink).toMatch(/^https:\/\/www\.facebook\.com\/reel\//);
    // Finished once.
    expect(fb.calls.filter((c) => c === `POST ${FB_PAGE}/video_reels`)).toHaveLength(2);
  });

  it("fails clearly when Facebook can't process the video", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    fb.videoStatuses = ["error"];
    const res = await createPost(u, { caption: "x", mediaIds: [(await addMedia(u, { type: "VIDEO", width: 1920, height: 1080 })).id], targets: [{ socialAccountId: page.id }] });
    expect(await runPublishCycle()).toEqual(["failed"]);
    expect(await targetOf(res.body.post.id)).toMatchObject({ lastErrorCode: "MEDIA_REJECTED", lastError: "Facebook couldn't process the video: Unsupported video format" });
  });
});

// ─── Failures and recovery ──────────────────────────────────────────────────

describe("never posting twice", () => {
  async function textPost(u: User, pageId: string) {
    const res = await createPost(u, { caption: "Hello Pune", targets: [{ socialAccountId: pageId }] });
    return targetOf(res.body.post.id);
  }

  it("when Facebook created the post but the answer was lost, finds it instead of posting again", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const target = await textPost(u, page.id);
    fb.failures.push({ match: "POST 1000000000000001/feed", status: 500, body: { error: { message: "An unknown error occurred", code: 1 } }, thenCreate: true });

    expect(await runPublishCycle()).toEqual(["retry_scheduled"]);
    expect(fb.posts).toHaveLength(1);
    await prisma.postTarget.update({ where: { id: target.id }, data: { nextAttemptAt: new Date() } });
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(fb.posts).toHaveLength(1);
    expect(feedCalls()).toHaveLength(1);
    expect((await targetOf(target.postId)).externalPostId).toBe(fb.posts[0]!.id);
  });

  it("stops (and lets the user retry) when it can't tell whether Facebook published", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const target = await textPost(u, page.id);
    // Facebook failed on its side and did NOT create the post.
    fb.failures.push({ match: "POST 1000000000000001/feed", status: 503, body: { error: { message: "Service temporarily unavailable", code: 2 } } });
    await runPublishCycle();
    await prisma.postTarget.update({ where: { id: target.id }, data: { nextAttemptAt: new Date() } });

    expect(await runPublishCycle()).toEqual(["failed"]);
    expect((await targetOf(target.postId)).lastError).toContain("Couldn't confirm whether Facebook published this post");
    expect(fb.posts).toHaveLength(0);

    // The user checked the Page and retries: it posts once.
    const retry = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/posts/${target.postId}/targets/${target.id}/retry`).set(auth(u));
    expect(retry.status).toBe(200);
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(fb.posts).toHaveLength(1);
  });

  it("retries normally after a clear rejection, since nothing was created", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const target = await textPost(u, page.id);
    fb.failures.push({ match: "POST 1000000000000001/feed", status: 400, body: { error: { message: "(#4) Application request limit reached", code: 4 } } });
    expect(await runPublishCycle()).toEqual(["retry_scheduled"]);
    await prisma.postTarget.update({ where: { id: target.id }, data: { nextAttemptAt: new Date() } });
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(fb.posts).toHaveLength(1);
  });

  it("doesn't upload multi-photo photos again on a retry", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const res = await createPost(u, { caption: "Two", mediaIds: [(await addMedia(u)).id, (await addMedia(u)).id], targets: [{ socialAccountId: page.id }] });
    fb.failures.push({ match: "POST 1000000000000001/feed", status: 400, body: { error: { message: "Please reduce the amount of data", code: 17 } } });
    expect(await runPublishCycle()).toEqual(["retry_scheduled"]);
    const target = await targetOf(res.body.post.id);
    await prisma.postTarget.update({ where: { id: target.id }, data: { nextAttemptAt: new Date() } });
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(fb.photos.size).toBe(2);
  });

  it("asks for a reconnect when the Page token stops working", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const target = await textPost(u, page.id);
    fb.failures.push({ match: "POST 1000000000000001/feed", status: 400, body: { error: { message: "Error validating access token", code: 190 } } });
    expect(await runPublishCycle()).toEqual(["failed"]);
    expect(await targetOf(target.postId)).toMatchObject({ lastErrorCode: "TOKEN_INVALID", lastError: "Facebook rejected this account's access. Reconnect it, then retry." });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: page.id } })).status).toBe("NEEDS_REAUTH");
  });

  it("after a crash around the Reel's final step, finishes it only if Facebook didn't get it", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const video = await addMedia(u, { type: "VIDEO", width: 1080, height: 1920, durationSec: 20 });
    const res = await createPost(u, { caption: "Reel", mediaIds: [video.id], targets: [{ socialAccountId: page.id }] });
    const target = await targetOf(res.body.post.id);
    fb.videoStatuses = ["processing"];
    expect(await runPublishCycle()).toEqual(["waiting"]);
    const [videoId, reel] = [...fb.videos.entries()][0]!;
    const finishCalls = () => fb.calls.filter((c) => c === `POST ${FB_PAGE}/video_reels`).length;
    expect(finishCalls()).toBe(2); // start + finish

    // As if we crashed after sending "finish" but before saving that it was done.
    const crashed = { videoId, reelUploaded: true, creating: true, _startedAt: new Date().toISOString() };
    await prisma.postTarget.update({ where: { id: target.id }, data: { status: "QUEUED", nextAttemptAt: new Date(), platformState: crashed } });
    reel.statuses = ["ready"];
    expect(await processTarget(target.id)).toBe("published");
    expect(finishCalls()).toBe(2); // Facebook had it: not finished again

    // The other case: Facebook never got "finish". It's sent now.
    reel.finished = false;
    reel.postId = undefined;
    await prisma.postTarget.update({ where: { id: target.id }, data: { status: "QUEUED", nextAttemptAt: new Date(), platformState: crashed } });
    expect(await processTarget(target.id)).toBe("published");
    expect(finishCalls()).toBe(3);
  });
});

// ─── Analytics ──────────────────────────────────────────────────────────────

describe("Facebook analytics", () => {
  it("collects post and Page numbers from the metrics Facebook still offers", async () => {
    const u = await signUp();
    const page = await connectPage(u);
    const res = await createPost(u, { caption: "Numbers", mediaIds: [(await addMedia(u)).id], targets: [{ socialAccountId: page.id }] });
    await runPublishCycle();
    const target = await targetOf(res.body.post.id);
    const summary = await runAnalyticsCollection(new Date(target.publishedAt!.getTime() + 2 * HOUR), { callsPerAccount: 200 });
    expect(summary).toMatchObject({ posts: 1, days: 30, followers: 1, stopped: 0 });

    expect(await prisma.postTargetMetrics.findUniqueOrThrow({ where: { postTargetId: target.id } })).toMatchObject({
      status: "OK",
      views: 3400,
      reach: 2100,
      likes: 95, // all reactions
      comments: 14,
      shares: 9,
      totalInteractions: 118,
      saves: null,
    });
    const day = await prisma.accountDailyStats.findFirstOrThrow({ where: { socialAccountId: page.id, insightsFetchedAt: { not: null } } });
    expect(day).toMatchObject({ views: 700, reach: 450, follows: null, unfollows: null, totalInteractions: null });
    expect((await prisma.accountDailyStats.findFirstOrThrow({ where: { socialAccountId: page.id, followers: { not: null } } })).followers).toBe(3100);
    // No "when followers are online" for Pages.
    expect((await prisma.accountAudience.findUniqueOrThrow({ where: { socialAccountId: page.id } })).onlineGrid).toBeNull();
  });
});
