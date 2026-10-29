import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { runPublishCycle } from "../src/jobs/publishQueue.js";
import { splitThread, weightedLength, X_MAX_WEIGHT } from "../src/integrations/x/text.js";
import { refreshAccountToken, refreshDueTokens } from "../src/services/tokenRefresh.service.js";
import { decryptToken } from "../src/utils/tokenCrypto.js";
import {
  addMedia,
  auth,
  connectX,
  createPost,
  FAKE_IMAGE,
  FAKE_VIDEO,
  fastForward,
  installFakes,
  signUp,
  targetOf,
  type User,
  X_USER,
  xf,
} from "./support.js";

beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces, audit_logs CASCADE");
  installFakes();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

const HOUR = 3_600_000;
const sentence = (n: number) => `Sentence number ${n} explains one more idea about scheduling posts.`;

// ─── Length and threads ─────────────────────────────────────────────────────

describe("X post length and threads", () => {
  it("counts characters the way X does", () => {
    expect(weightedLength("Hello, world!")).toBe(13);
    // Emoji count 2, even when built from several code points.
    expect(weightedLength("🎉")).toBe(2);
    expect(weightedLength("👩🏽‍💻")).toBe(2);
    // CJK counts 2 per character.
    expect(weightedLength("日本語")).toBe(6);
    // Every URL counts 23, however long.
    expect(weightedLength(`Read https://example.com/${"a".repeat(100)} now`)).toBe(4 + 1 + 23 + 4);
    expect(weightedLength("é")).toBe(1);
    expect(weightedLength("é")).toBe(1); // normalized to é first
  });

  it("keeps text that fits as one post, untouched", () => {
    expect(splitThread("  Just one post  ")).toEqual(["Just one post"]);
    expect(splitThread("x".repeat(X_MAX_WEIGHT))).toEqual(["x".repeat(X_MAX_WEIGHT)]);
    expect(splitThread("   ")).toEqual([]);
  });

  it("splits long text at sentence ends into numbered posts that each fit", () => {
    const text = Array.from({ length: 12 }, (_, i) => sentence(i + 1)).join(" ");
    const posts = splitThread(text);
    expect(posts.length).toBeGreaterThan(1);
    posts.forEach((p, i) => {
      expect(weightedLength(p)).toBeLessThanOrEqual(X_MAX_WEIGHT);
      expect(p.endsWith(` ${i + 1}/${posts.length}`)).toBe(true);
      // Each post ends on a full sentence.
      expect(p.replace(/ \d+\/\d+$/, "")).toMatch(/\.$/);
    });
    // Nothing is lost or reordered.
    expect(posts.map((p) => p.replace(/ \d+\/\d+$/, "")).join(" ")).toBe(text);
  });

  it("starts a new post at each --- line the author writes", () => {
    expect(splitThread("First idea.\n---\nSecond idea.\n  ---  \nThird idea.")).toEqual(["First idea. 1/3", "Second idea. 2/3", "Third idea. 3/3"]);
  });

  it("cuts a word that's longer than a post", () => {
    const posts = splitThread("y".repeat(600));
    expect(posts).toHaveLength(3);
    expect(posts.every((p) => weightedLength(p) <= X_MAX_WEIGHT)).toBe(true);
    expect(posts.map((p) => p.replace(/ \d+\/\d+$/, "")).join("")).toBe("y".repeat(600));
  });
});

// ─── Connecting ─────────────────────────────────────────────────────────────

describe("connecting X", () => {
  async function startConnect(u: User) {
    const res = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/social-accounts/x/connect`).set(auth(u));
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizationUrl);
    xf.codeChallenge = url.searchParams.get("code_challenge");
    return url;
  }
  const callback = (query: Record<string, string>) => request(app).get(`/api/v1/integrations/x/callback?${new URLSearchParams(query)}`);

  it("asks for posting, media and offline access, with a PKCE challenge", async () => {
    const url = await startConnect(await signUp());
    expect(`${url.origin}${url.pathname}`).toBe("https://x.com/i/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "test-x-client-id",
      redirect_uri: env.x!.redirectUri,
      scope: "tweet.read tweet.write users.read media.write offline.access",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  });

  it("connects the account, proving the PKCE verifier, and stores 2-hour access that renews itself", async () => {
    const u = await signUp();
    const state = (await startConnect(u)).searchParams.get("state")!;
    const res = await callback({ code: "x-good-code", state });
    expect(res.headers.location).toBe(`${env.appUrl}/accounts?connected=x&count=1`);

    const account = await prisma.socialAccount.findFirstOrThrow({ where: { workspaceId: u.workspaceId }, include: { token: true } });
    expect(account).toMatchObject({ platform: "X", externalId: X_USER, accountType: "USER", username: "pragya_builds", name: "Pragya Rajput" });
    expect(decryptToken(account.token!.accessTokenEnc)).toBe("x-token");
    expect(decryptToken(account.token!.refreshTokenEnc!)).toBe("x-refresh");
    expect(account.token!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 1.9 * HOUR);
    expect(account.token!.expiresAt!.getTime()).toBeLessThan(Date.now() + 2.1 * HOUR);

    const list = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/social-accounts`).set(auth(u));
    expect(list.body.accounts[0]).toMatchObject({ platform: "X", tokenRenews: true });
    expect(list.body.platforms).toContainEqual({ platform: "X", displayName: "X", configured: true, connectMethod: "oauth" });
    expect(JSON.stringify(list.body)).not.toContain("x-token");
  });

  it("fails when the verifier doesn't match the challenge", async () => {
    const u = await signUp();
    const state = (await startConnect(u)).searchParams.get("state")!;
    xf.codeChallenge = "someone-elses-challenge";
    const res = await callback({ code: "x-good-code", state });
    expect(res.headers.location).toContain("error=platform_error");
    expect(await prisma.socialAccount.count()).toBe(0);
  });
});

// ─── Publishing ─────────────────────────────────────────────────────────────

describe("publishing to X", () => {
  it("publishes a short text as one post, and links to it", async () => {
    const u = await signUp();
    const account = await connectX(u);
    const res = await createPost(u, { caption: "Shipping X support today 🚀", targets: [{ socialAccountId: account.id }] });
    expect(res.status).toBe(201);
    expect(res.body.post.targets[0]).toMatchObject({ format: "TEXT", account: { platform: "X", username: "pragya_builds" } });

    expect(await runPublishCycle()).toEqual(["published"]);
    expect(xf.posts).toHaveLength(1);
    expect(xf.posts[0]!.body).toEqual({ text: "Shipping X support today 🚀" });
    expect(await targetOf(res.body.post.id)).toMatchObject({
      status: "PUBLISHED",
      externalPostId: xf.posts[0]!.id,
      permalink: `https://x.com/i/web/status/${xf.posts[0]!.id}`,
    });
  });

  it("publishes long text as a thread: each post replies to the one before", async () => {
    const u = await signUp();
    const account = await connectX(u);
    const caption = Array.from({ length: 12 }, (_, i) => sentence(i + 1)).join(" ");
    const res = await createPost(u, { caption, targets: [{ socialAccountId: account.id }] });
    expect(res.status).toBe(201);

    expect(await runPublishCycle()).toEqual(["published"]);
    const expected = splitThread(caption);
    expect(xf.posts.map((p) => p.body.text)).toEqual(expected);
    expect(xf.posts[0]!.body.reply).toBeUndefined();
    for (let i = 1; i < xf.posts.length; i++) {
      expect(xf.posts[i]!.body.reply).toEqual({ in_reply_to_tweet_id: xf.posts[i - 1]!.id });
    }
    // The target links to the first post of the thread.
    expect((await targetOf(res.body.post.id)).externalPostId).toBe(xf.posts[0]!.id);
  });

  it("attaches photos to the first post of a thread only", async () => {
    const u = await signUp();
    const account = await connectX(u);
    const photos = [await addMedia(u), await addMedia(u)];
    const res = await createPost(u, { caption: "Team offsite.\n---\nMore photos soon.", mediaIds: photos.map((p) => p.id), targets: [{ socialAccountId: account.id }] });
    expect(res.body.post.targets[0].format).toBe("CAROUSEL");

    expect(await runPublishCycle()).toEqual(["published"]);
    const uploaded = [...xf.uploads.entries()];
    expect(uploaded).toHaveLength(2);
    expect(uploaded.every(([, up]) => up.chunks.get(0)!.equals(FAKE_IMAGE))).toBe(true);
    expect(xf.posts[0]!.body.media).toEqual({ media_ids: uploaded.map(([id]) => id) });
    expect(xf.posts[1]!.body.media).toBeUndefined();
  });

  it("uploads a video in chunks, waits while X processes it, then posts it", async () => {
    const u = await signUp();
    const account = await connectX(u);
    const video = await addMedia(u, { type: "VIDEO", durationSec: 45, bytes: FAKE_VIDEO.length });
    xf.videoStates = ["pending", "in_progress", "succeeded"];
    const res = await createPost(u, { caption: "Product demo", mediaIds: [video.id], targets: [{ socialAccountId: account.id }] });
    expect(res.body.post.targets[0].format).toBe("VIDEO");

    expect(await runPublishCycle()).toEqual(["waiting"]);
    const [[id, upload]] = [...xf.uploads.entries()];
    expect(upload!.chunks.size).toBe(3);
    // Buffer.equals: a deep comparison of 9 MB is very slow.
    expect(Buffer.concat([...upload!.chunks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b)).equals(FAKE_VIDEO)).toBe(true);
    expect(xf.posts).toHaveLength(0);

    await fastForward();
    expect(await runPublishCycle()).toEqual(["waiting"]);
    await fastForward();
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(xf.posts[0]!.body.media).toEqual({ media_ids: [id] });
    // Uploaded once, even though it was checked three times.
    expect(xf.calls.filter((c) => c === "POST /2/media/upload/initialize")).toHaveLength(1);
    expect((await targetOf(res.body.post.id)).status).toBe("PUBLISHED");
  });

  it("fails clearly when X can't process the video", async () => {
    const u = await signUp();
    const account = await connectX(u);
    xf.videoStates = ["failed"];
    const res = await createPost(u, { caption: "Clip", mediaIds: [(await addMedia(u, { type: "VIDEO", bytes: FAKE_VIDEO.length })).id], targets: [{ socialAccountId: account.id }] });
    expect(await runPublishCycle()).toEqual(["failed"]);
    expect(await targetOf(res.body.post.id)).toMatchObject({ status: "FAILED", lastErrorCode: "MEDIA_REJECTED", lastError: "X couldn't process the video: Unsupported codec" });
  });

  it("carries on a thread after a rate limit, without posting the first part twice", async () => {
    const u = await signUp();
    const account = await connectX(u);
    const res = await createPost(u, { caption: "One.\n---\nTwo.\n---\nThree.", targets: [{ socialAccountId: account.id }] });
    // The first post goes through; the second hits the rate limit.
    xf.failures.push({ match: "POST /2/tweets", afterPosts: 1, status: 429, body: { title: "Too Many Requests", detail: "Too Many Requests", type: "about:blank", status: 429 } });

    expect(await runPublishCycle()).toEqual(["retry_scheduled"]);
    expect(xf.posts.map((p) => p.body.text)).toEqual(["One. 1/3"]);
    expect(await targetOf(res.body.post.id)).toMatchObject({ status: "QUEUED", lastErrorCode: "RATE_LIMITED", lastError: "1 of 3 posts in the thread is on X; post 2 failed: Too Many Requests" });

    await fastForward();
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(xf.posts.map((p) => p.body.text)).toEqual(["One. 1/3", "Two. 2/3", "Three. 3/3"]);
    expect(xf.posts[1]!.body.reply).toEqual({ in_reply_to_tweet_id: xf.posts[0]!.id });
  });

  it("stops instead of posting twice when it can't tell whether a post went through", async () => {
    const u = await signUp();
    const account = await connectX(u);
    const res = await createPost(u, { caption: "Hello", targets: [{ socialAccountId: account.id }] });
    xf.failures.push({ match: "POST /2/tweets", status: 503, body: { title: "Service Unavailable", detail: "Service Unavailable", type: "about:blank", status: 503 } });

    expect(await runPublishCycle()).toEqual(["retry_scheduled"]);
    await fastForward();
    expect(await runPublishCycle()).toEqual(["failed"]);
    expect(await targetOf(res.body.post.id)).toMatchObject({ status: "FAILED", lastError: "Couldn't confirm whether X published this post. Check your X profile; if it isn't there, retry." });
    expect(xf.posts).toHaveLength(0);
  });

  it("rejects what X can't post, before scheduling it", async () => {
    const u = await signUp();
    const account = await connectX(u);
    const photos = await Promise.all(Array.from({ length: 5 }, () => addMedia(u)));
    const tooMany = await createPost(u, { caption: "Gallery", mediaIds: photos.map((p) => p.id), targets: [{ socialAccountId: account.id }] });
    expect(tooMany.status).toBe(400);
    expect(JSON.stringify(tooMany.body)).toContain("X posts can have at most 4 photos.");

    const huge = await createPost(u, { caption: Array.from({ length: 30 }, (_, i) => `Part ${i}.`).join("\n---\n"), targets: [{ socialAccountId: account.id }] });
    expect(huge.status).toBe(400);
    expect(JSON.stringify(huge.body)).toContain("threads here can have at most 25");
  });
});

// ─── Keeping access ─────────────────────────────────────────────────────────

describe("X access renewal", () => {
  it("renews access that's about to expire before publishing, and uses the new token", async () => {
    const u = await signUp();
    const account = await connectX(u, { expiresAt: new Date(Date.now() + 60_000) });
    await createPost(u, { caption: "Fresh token", targets: [{ socialAccountId: account.id }] });

    expect(await runPublishCycle()).toEqual(["published"]);
    expect(xf.refreshes).toBe(1);
    expect(xf.posts[0]!.token).toBe("x-token-2");
    const token = await prisma.oAuthToken.findUniqueOrThrow({ where: { socialAccountId: account.id } });
    // X replaced the refresh token; the old one no longer works.
    expect(decryptToken(token.refreshTokenEnc!)).toBe("x-refresh-2");
    expect(token.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 1.9 * HOUR);
  });

  it("renews access that already expired, since X's refresh token outlives it", async () => {
    const u = await signUp();
    const account = await connectX(u, { expiresAt: new Date(Date.now() - HOUR) });
    expect(await refreshDueTokens()).toMatchObject({ refreshed: 1, needsReauth: 0 });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("ACTIVE");
  });

  it("asks for a reconnect when X rejects the refresh token", async () => {
    const u = await signUp();
    const account = await connectX(u, { refreshToken: "revoked" });
    expect(await refreshDueTokens()).toMatchObject({ refreshed: 0, needsReauth: 1 });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("NEEDS_REAUTH");
  });

  it("refreshes once when two refreshes race, so the rotated refresh token isn't used twice", async () => {
    const u = await signUp();
    const account = await connectX(u, { expiresAt: new Date(Date.now() + 60_000) });
    const outcomes = await Promise.all([
      refreshAccountToken(account, new Date(), { unlessValidFor: 5 * 60_000 }),
      refreshAccountToken(account, new Date(), { unlessValidFor: 5 * 60_000 }),
    ]);
    expect(outcomes.sort()).toEqual(["fresh", "refreshed"]);
    expect(xf.refreshes).toBe(1);
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("ACTIVE");
  });
});
