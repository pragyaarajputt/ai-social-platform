import { createHash } from "node:crypto";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { claimDueTargets, processTarget, runPublishCycle } from "../src/jobs/publishQueue.js";
import { addMedia, auth, connectAccount, createPost, fake, fastForward, installFakes, signUp, targetOf, type User } from "./support.js";

beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces, audit_logs CASCADE");
  installFakes();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

// ─── Media ──────────────────────────────────────────────────────────────────

describe("media uploads", () => {
  it("signs a direct upload to a server-chosen path inside the workspace", async () => {
    const u = await signUp();
    const res = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/media/upload-signature`).set(auth(u));
    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toBe("https://api.cloudinary.com/v1_1/test-cloud/auto/upload");
    const { public_id, timestamp, api_key, signature } = res.body.fields;
    expect(public_id).toMatch(new RegExp(`^ai-social/${u.workspaceId}/[0-9a-f-]{36}$`));
    expect(api_key).toBe("test-cloudinary-key");
    const expected = createHash("sha1").update(`public_id=${public_id}&timestamp=${timestamp}test-cloudinary-secret`).digest("hex");
    expect(signature).toBe(expected);
  });

  it("registers an upload using Cloudinary's metadata, not the browser's", async () => {
    const u = await signUp();
    const publicId = `ai-social/${u.workspaceId}/abc`;
    fake.cloudinary.set(publicId, {
      public_id: publicId, resource_type: "image", format: "png", bytes: 123456, width: 1080, height: 1350,
      secure_url: `https://res.cloudinary.com/test-cloud/image/upload/v1/${publicId}.png`,
    });
    const res = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/media`).set(auth(u))
      .send({ publicId, resourceType: "image", width: 99999 });
    expect(res.status).toBe(201);
    expect(res.body.media).toMatchObject({ type: "IMAGE", format: "png", bytes: 123456, width: 1080, height: 1350 });

    const list = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/media`).set(auth(u));
    expect(list.body.media).toHaveLength(1);
    const del = await request(app).delete(`/api/v1/workspaces/${u.workspaceId}/media/${res.body.media.id}`).set(auth(u));
    expect(del.status).toBe(204);
    expect((await request(app).get(`/api/v1/workspaces/${u.workspaceId}/media`).set(auth(u))).body.media).toHaveLength(0);
  });

  it("rejects uploads outside the workspace, missing uploads, and unsupported video formats", async () => {
    const u = await signUp();
    const other = await signUp();
    const outside = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/media`).set(auth(u))
      .send({ publicId: `ai-social/${other.workspaceId}/x`, resourceType: "image" });
    expect(outside.body.error.code).toBe("INVALID_UPLOAD");

    const missing = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/media`).set(auth(u))
      .send({ publicId: `ai-social/${u.workspaceId}/nope`, resourceType: "image" });
    expect(missing.body.error.code).toBe("INVALID_UPLOAD");

    const publicId = `ai-social/${u.workspaceId}/clip`;
    fake.cloudinary.set(publicId, { public_id: publicId, resource_type: "video", format: "avi", bytes: 1, width: 1, height: 1, duration: 10, secure_url: "https://x" });
    const avi = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/media`).set(auth(u)).send({ publicId, resourceType: "video" });
    expect(avi.status).toBe(400);
    expect(avi.body.error.code).toBe("UNSUPPORTED_FORMAT");
  });
});

// ─── Creating posts ─────────────────────────────────────────────────────────

describe("creating a post", () => {
  it("validates against Instagram's rules for each chosen account", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const tall = await addMedia(u, { width: 1080, height: 1920 }); // 9:16 isn't allowed for feed images
    const targets = [{ socialAccountId: account.id }];

    const noMedia = await createPost(u, { caption: "hi", mediaIds: [], targets });
    expect(noMedia.status).toBe(400);
    expect(JSON.stringify(noMedia.body)).toContain("at least one photo or video");

    const ratio = await createPost(u, { caption: "hi", mediaIds: [tall.id], targets });
    expect(JSON.stringify(ratio.body)).toContain("aspect ratio 1080:1920");

    const square = await addMedia(u);
    const tags = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    const hashtags = await createPost(u, { caption: tags, mediaIds: [square.id], targets });
    expect(JSON.stringify(hashtags.body)).toContain("at most 30 hashtags");

    const long = await createPost(u, { caption: "a".repeat(2201), mediaIds: [square.id], targets });
    expect(JSON.stringify(long.body)).toContain("2201 characters");

    expect(await prisma.post.count()).toBe(0);
  });

  it("refuses accounts that need reconnecting, and media from another workspace", async () => {
    const u = await signUp();
    const stale = await connectAccount(u, { status: "NEEDS_REAUTH" });
    const img = await addMedia(u);
    const res = await createPost(u, { caption: "hi", mediaIds: [img.id], targets: [{ socialAccountId: stale.id }] });
    expect(JSON.stringify(res.body)).toContain("needs to be reconnected");

    const other = await signUp();
    const theirs = await addMedia(other);
    const ok = await connectAccount(u, { externalId: "2", username: "second" });
    const cross = await createPost(u, { caption: "hi", mediaIds: [theirs.id], targets: [{ socialAccountId: ok.id }] });
    expect(cross.body.error.code).toBe("MEDIA_NOT_FOUND");
  });

  it("creates the post and one queued target per account in one go", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const img = await addMedia(u);
    const res = await createPost(u, { caption: "Hello #launch", mediaIds: [img.id], targets: [{ socialAccountId: account.id }] });
    expect(res.status).toBe(201);
    expect(res.body.post).toMatchObject({ status: "PUBLISHING", caption: "Hello #launch" });
    expect(res.body.post.targets).toEqual([expect.objectContaining({ format: "IMAGE", status: "QUEUED" })]);
    const target = await targetOf(res.body.post.id);
    expect(target.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("only lets EDITORs and above create posts, and hides other workspaces' posts", async () => {
    const owner = await signUp();
    const account = await connectAccount(owner);
    const img = await addMedia(owner);
    const post = (await createPost(owner, { caption: "x", mediaIds: [img.id], targets: [{ socialAccountId: account.id }] })).body.post;

    const viewer = await signUp();
    await prisma.workspaceMember.create({ data: { workspaceId: owner.workspaceId, userId: viewer.userId, role: "VIEWER" } });
    const denied = await request(app).post(`/api/v1/workspaces/${owner.workspaceId}/posts`).set(auth(viewer))
      .send({ caption: "x", mediaIds: [img.id], targets: [{ socialAccountId: account.id }] });
    expect(denied.status).toBe(403);

    const stranger = await signUp();
    const hidden = await request(app).get(`/api/v1/workspaces/${stranger.workspaceId}/posts/${post.id}`).set(auth(stranger));
    expect(hidden.status).toBe(404);
  });
});

// ─── Publishing ─────────────────────────────────────────────────────────────

async function queuedPost(u: User, mediaIds: string[], accounts: { id: string }[], caption = "Hello #launch") {
  const res = await createPost(u, { caption, mediaIds, targets: accounts.map((a) => ({ socialAccountId: a.id })) });
  expect(res.status).toBe(201);
  return res.body.post.id as string;
}

describe("publishing to Instagram", () => {
  it("publishes a single image as JPEG and records the link", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const img = await addMedia(u);
    const postId = await queuedPost(u, [img.id], [account]);

    expect(await runPublishCycle()).toEqual(["published"]);
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.createCalls[0]).toEqual({
      image_url: `https://res.cloudinary.com/test-cloud/image/upload/c_limit,w_1440,q_auto/v1/${img.publicId}.jpg`,
      caption: "Hello #launch",
    });

    const target = await targetOf(postId);
    expect(target).toMatchObject({ status: "PUBLISHED", externalPostId: "m1", permalink: "https://www.instagram.com/p/m1/" });
    expect((await prisma.post.findUniqueOrThrow({ where: { id: postId } })).status).toBe("PUBLISHED");

    const detail = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/posts/${postId}`).set(auth(u));
    expect(detail.body.post.targets[0]).toMatchObject({ status: "PUBLISHED", permalink: "https://www.instagram.com/p/m1/" });
  });

  it("publishes a carousel: one child per item, then the carousel", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const a = await addMedia(u);
    const b = await addMedia(u, { type: "VIDEO" });
    const postId = await queuedPost(u, [a.id, b.id], [account]);

    expect(await runPublishCycle()).toEqual(["published"]);
    expect(fake.createCalls.map((c) => c.media_type ?? "IMAGE")).toEqual(["IMAGE", "VIDEO", "CAROUSEL"]);
    expect(fake.createCalls[0]).toMatchObject({ is_carousel_item: "true" });
    expect(fake.createCalls[1]).toMatchObject({ is_carousel_item: "true", video_url: b.secureUrl });
    expect(fake.createCalls[2]).toMatchObject({ children: "c1,c2", caption: "Hello #launch" });
    expect((await targetOf(postId)).format).toBe("CAROUSEL");
  });

  it("waits for a Reel to finish processing without blocking, then publishes it once", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const video = await addMedia(u, { type: "VIDEO", width: 1080, height: 1920 });
    fake.videoStatuses = ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"];
    const postId = await queuedPost(u, [video.id], [account]);

    expect(await runPublishCycle()).toEqual(["waiting"]);
    let target = await targetOf(postId);
    expect(target.status).toBe("WAITING_FOR_MEDIA");
    expect(target.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(25_000);
    expect(await runPublishCycle()).toEqual([]); // not due yet

    await fastForward();
    expect(await runPublishCycle()).toEqual(["waiting"]);
    await fastForward();
    expect(await runPublishCycle()).toEqual(["published"]);

    expect(fake.createCalls).toHaveLength(1);
    expect(fake.createCalls[0]).toMatchObject({ media_type: "REELS", video_url: video.secureUrl, share_to_feed: "true" });
    target = await targetOf(postId);
    expect(target.status).toBe("PUBLISHED");
  });

  it("after a failure between creating and publishing, retries without creating a second container", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const img = await addMedia(u);
    fake.publishFailures = [{ status: 500, body: { error: { message: "An unexpected error has occurred", code: 2 } } }];
    const postId = await queuedPost(u, [img.id], [account]);

    expect(await runPublishCycle()).toEqual(["retry_scheduled"]);
    let target = await targetOf(postId);
    expect(target).toMatchObject({ status: "QUEUED", attempts: 1, lastErrorCode: "UNAVAILABLE" });
    expect(target.platformState).toMatchObject({ containerId: "c1" });
    const wait = target.nextAttemptAt!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(25_000);
    expect(wait).toBeLessThanOrEqual(30_000);

    await fastForward();
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(fake.createCalls).toHaveLength(1);
    expect(fake.publishCalls).toEqual(["c1"]);
    target = await targetOf(postId);
    expect(target.status).toBe("PUBLISHED");
  });

  it("after a crash right after Instagram published, recovers the post instead of publishing again", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const img = await addMedia(u);
    const postId = await queuedPost(u, [img.id], [account]);

    // Simulate: container created and published on Instagram, but the worker died before saving the media ID.
    fake.containers.set("c1", { params: {}, statuses: ["FINISHED"], published: true });
    fake.media.unshift({ id: "m42", permalink: "https://www.instagram.com/p/m42/", timestamp: new Date().toISOString() });
    await prisma.postTarget.updateMany({
      where: { postId },
      data: { platformState: { containerId: "c1", _startedAt: new Date(Date.now() - 5000).toISOString() } },
    });

    expect(await runPublishCycle()).toEqual(["published"]);
    expect(fake.publishCalls).toEqual([]);
    expect(fake.createCalls).toEqual([]);
    expect(await targetOf(postId)).toMatchObject({ status: "PUBLISHED", externalPostId: "m42", permalink: "https://www.instagram.com/p/m42/" });
  });

  it("stops and asks for a reconnect when Instagram rejects the token", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const img = await addMedia(u);
    fake.createFailures = [{ status: 400, body: { error: { message: "Error validating access token", code: 190 } } }];
    const postId = await queuedPost(u, [img.id], [account]);

    expect(await runPublishCycle()).toEqual(["failed"]);
    expect(await targetOf(postId)).toMatchObject({ status: "FAILED", lastErrorCode: "TOKEN_INVALID" });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("NEEDS_REAUTH");
    expect((await prisma.post.findUniqueOrThrow({ where: { id: postId } })).status).toBe("FAILED");
  });

  it("fails without retrying when Instagram can't process the media", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const video = await addMedia(u, { type: "VIDEO", width: 1080, height: 1920 });
    fake.videoStatuses = ["ERROR"];
    const postId = await queuedPost(u, [video.id], [account]);

    expect(await runPublishCycle()).toEqual(["failed"]);
    const target = await targetOf(postId);
    expect(target).toMatchObject({ status: "FAILED", lastErrorCode: "MEDIA_REJECTED" });
    expect(target.lastError).toContain("Unsupported codec");
  });

  it("retries temporary errors with growing waits, then gives up after 5 attempts", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const img = await addMedia(u);
    fake.createFailures = Array.from({ length: 5 }, () => ({ status: 503, body: { error: { message: "Service unavailable", code: 2 } } }));
    const postId = await queuedPost(u, [img.id], [account]);

    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      expect(await runPublishCycle()).toEqual(["retry_scheduled"]);
      const t = await targetOf(postId);
      waits.push(Math.round((t.nextAttemptAt!.getTime() - Date.now()) / 1000));
      await fastForward();
    }
    expect(waits[0]).toBeGreaterThanOrEqual(29);
    expect(waits[1]).toBeGreaterThanOrEqual(119);
    expect(waits[2]).toBeGreaterThanOrEqual(479);
    expect(waits[3]).toBeGreaterThanOrEqual(1799);

    expect(await runPublishCycle()).toEqual(["failed"]);
    expect(await targetOf(postId)).toMatchObject({ status: "FAILED", attempts: 5 });
    expect(await prisma.publishAttempt.count({ where: { postTarget: { postId } } })).toBe(5);
  });

  it("marks a post partially failed, and a failed account can be retried without re-posting", async () => {
    const u = await signUp();
    const good = await connectAccount(u);
    const stale = await connectAccount(u, { externalId: "999", username: "stale" });
    const img = await addMedia(u);
    const postId = await queuedPost(u, [img.id], [good, stale]);
    // The second account's token was revoked after the post was queued.
    await prisma.socialAccount.update({ where: { id: stale.id }, data: { status: "NEEDS_REAUTH" } });

    expect((await runPublishCycle()).sort()).toEqual(["failed", "published"]);
    expect((await prisma.post.findUniqueOrThrow({ where: { id: postId } })).status).toBe("PARTIALLY_FAILED");

    const failed = await prisma.postTarget.findFirstOrThrow({ where: { postId, socialAccountId: stale.id } });
    expect(failed.lastErrorCode).toBe("ACCOUNT_NOT_CONNECTED");
    const retryUrl = `/api/v1/workspaces/${u.workspaceId}/posts/${postId}/targets/${failed.id}/retry`;
    expect((await request(app).post(retryUrl).set(auth(u))).body.error.code).toBe("ACCOUNT_NOT_READY");

    await prisma.socialAccount.update({ where: { id: stale.id }, data: { status: "ACTIVE" } });
    const retry = await request(app).post(retryUrl).set(auth(u));
    expect(retry.status).toBe(200);
    expect((await prisma.postTarget.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("QUEUED");

    const published = await prisma.postTarget.findFirstOrThrow({ where: { postId, socialAccountId: good.id } });
    const notFailed = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/posts/${postId}/targets/${published.id}/retry`).set(auth(u));
    expect(notFailed.status).toBe(409);
  });
});

describe("the queue", () => {
  it("never hands the same job to two workers", async () => {
    const u = await signUp();
    const accounts = await Promise.all(Array.from({ length: 6 }, (_, i) => connectAccount(u, { externalId: `x${i}`, username: `a${i}` })));
    const img = await addMedia(u);
    await queuedPost(u, [img.id], accounts);

    const [a, b, c] = await Promise.all([claimDueTargets(3), claimDueTargets(3), claimDueTargets(3)]);
    const all = [...a!, ...b!, ...c!];
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
  });

  it("picks a job back up when the worker holding it died", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const img = await addMedia(u);
    const postId = await queuedPost(u, [img.id], [account]);
    const [claimed] = await claimDueTargets(1);
    expect(await claimDueTargets(1)).toEqual([]); // locked

    await prisma.postTarget.update({ where: { id: claimed! }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect(await claimDueTargets(1)).toEqual([claimed]);
    expect(await processTarget(claimed!)).toBe("published");
    expect((await targetOf(postId)).status).toBe("PUBLISHED");
  });
});

describe("deleting a workspace", () => {
  it("removes its posts, media, targets and accounts", async () => {
    const u = await signUp();
    const account = await connectAccount(u);
    const img = await addMedia(u);
    const postId = await queuedPost(u, [img.id], [account]);
    expect(await runPublishCycle()).toEqual(["published"]);

    await prisma.workspace.delete({ where: { id: u.workspaceId } });
    expect(await prisma.post.count({ where: { id: postId } })).toBe(0);
    expect(await prisma.mediaAsset.count({ where: { id: img.id } })).toBe(0);
    expect(await prisma.postTarget.count({ where: { postId } })).toBe(0);
    expect(await prisma.socialAccount.count({ where: { id: account.id } })).toBe(0);
  });
});
