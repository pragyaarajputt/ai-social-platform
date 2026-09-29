import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { runConnectionHealthChecks } from "../src/jobs/connectionHealth.js";
import { runPublishCycle } from "../src/jobs/publishQueue.js";
import { toLittleText } from "../src/integrations/linkedin/client.js";
import { refreshDueTokens } from "../src/services/tokenRefresh.service.js";
import { decryptToken } from "../src/utils/tokenCrypto.js";
import {
  addMedia,
  auth,
  connectAccount,
  connectLinkedIn,
  createPost,
  FAKE_IMAGE,
  FAKE_VIDEO,
  fastForward,
  installFakes,
  li,
  LI_MEMBER,
  signUp,
  targetOf,
  type User,
} from "./support.js";

beforeEach(async () => {
  await prisma.$executeRawUnsafe("TRUNCATE TABLE users, workspaces, audit_logs CASCADE");
  installFakes();
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => prisma.$disconnect());

const DAY = 86_400_000;
const author = `urn:li:person:${LI_MEMBER}`;

// ─── Connecting ─────────────────────────────────────────────────────────────

describe("connecting LinkedIn", () => {
  async function startConnect(u: User) {
    const res = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/social-accounts/linkedin/connect`).set(auth(u));
    expect(res.status).toBe(200);
    return new URL(res.body.authorizationUrl);
  }
  const callback = (query: Record<string, string>) => request(app).get(`/api/v1/integrations/linkedin/callback?${new URLSearchParams(query)}`);

  it("asks for the profile and posting permissions only", async () => {
    const url = await startConnect(await signUp());
    expect(`${url.origin}${url.pathname}`).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "test-linkedin-client-id",
      redirect_uri: env.linkedin!.redirectUri,
      scope: "openid profile w_member_social",
    });
  });

  it("connects the member's profile with 60-day access that's renewed by reconnecting", async () => {
    const u = await signUp();
    const state = (await startConnect(u)).searchParams.get("state")!;
    const res = await callback({ code: "li-good-code", state });
    expect(res.headers.location).toBe(`${env.appUrl}/accounts?connected=linkedin&count=1`);

    const account = await prisma.socialAccount.findFirstOrThrow({ where: { workspaceId: u.workspaceId }, include: { token: true } });
    expect(account).toMatchObject({ platform: "LINKEDIN", externalId: LI_MEMBER, accountType: "PERSON", username: null, name: "Pragya Rajput", insightsAllowed: false });
    expect(decryptToken(account.token!.accessTokenEnc)).toBe("li-token");
    expect(account.token!.refreshTokenEnc).toBeNull();
    expect(account.token!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
    expect(account.token!.scopes).toEqual(["openid", "profile", "w_member_social"]);

    // The Accounts page learns that this access doesn't renew by itself; Instagram's does.
    await connectAccount(u);
    const list = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/social-accounts`).set(auth(u));
    expect(list.body.accounts.map((a: { platform: string; tokenRenews: boolean }) => [a.platform, a.tokenRenews])).toEqual([
      ["LINKEDIN", false],
      ["INSTAGRAM", true],
    ]);
    expect(list.body.platforms).toContainEqual({ platform: "LINKEDIN", displayName: "LinkedIn", configured: true });
    // Tokens never go to the browser.
    expect(JSON.stringify(list.body)).not.toContain("li-token");
  });

  it("reports a code LinkedIn rejects as a platform error", async () => {
    const u = await signUp();
    const res = await callback({ code: "bad-code", state: (await startConnect(u)).searchParams.get("state")! });
    expect(res.headers.location).toContain("error=platform_error");
    expect(await prisma.socialAccount.count()).toBe(0);
  });
});

// ─── Publishing ─────────────────────────────────────────────────────────────

describe("publishing to LinkedIn", () => {
  it("publishes a text post with LinkedIn's API version, and links to it", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u);
    const res = await createPost(u, { caption: "We're hiring! #Engineering", targets: [{ socialAccountId: account.id }] });
    expect(res.status).toBe(201);
    expect(res.body.post.targets[0]).toMatchObject({ format: "TEXT", account: { platform: "LINKEDIN", name: "Pragya Rajput" } });

    expect(await runPublishCycle()).toEqual(["published"]);
    expect(li.posts).toHaveLength(1);
    const [post] = li.posts;
    expect(post!.body).toMatchObject({ author, commentary: "We're hiring! {hashtag|\\#|Engineering}", visibility: "PUBLIC", lifecycleState: "PUBLISHED" });
    expect(post!.body.content).toBeUndefined();
    expect(li.restHeaders.every((h) => h.get("linkedin-version") === "202609")).toBe(true);
    expect(await targetOf(res.body.post.id)).toMatchObject({
      status: "PUBLISHED",
      externalPostId: post!.id,
      permalink: `https://www.linkedin.com/feed/update/${post!.id}/`,
    });
  });

  it("escapes LinkedIn's formatting characters so text shows exactly as typed", () => {
    expect(toLittleText(String.raw`Big news (really): 50% off *today* for @everyone [only] #Launch_Day a#b \ ~done_ <3 {x|y}`)).toBe(
      String.raw`Big news \(really\): 50% off \*today\* for \@everyone \[only\] {hashtag|\#|Launch\_Day} a\#b \\ \~done\_ \<3 \{x\|y\}`,
    );
    expect(toLittleText("Line one\n#tag at the start\n#")).toBe("Line one\n{hashtag|\\#|tag} at the start\n\\#");
  });

  it("uploads a photo, then posts it", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u);
    const photo = await addMedia(u);
    const res = await createPost(u, { caption: "New office", mediaIds: [photo.id], targets: [{ socialAccountId: account.id }] });
    expect(res.body.post.targets[0].format).toBe("IMAGE");

    expect(await runPublishCycle()).toEqual(["published"]);
    const [image] = [...li.images.entries()];
    // The processed JPEG from our storage, sent as bytes.
    expect(image![1].bytes).toEqual(FAKE_IMAGE);
    expect(li.posts[0]!.body.content).toEqual({ media: { id: image![0] } });
  });

  it("posts several photos as one multi-image post, in order", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u);
    const photos = [await addMedia(u), await addMedia(u), await addMedia(u)];
    const res = await createPost(u, { caption: "Team offsite", mediaIds: photos.map((p) => p.id), targets: [{ socialAccountId: account.id }] });
    expect(res.body.post.targets[0].format).toBe("CAROUSEL");

    expect(await runPublishCycle()).toEqual(["published"]);
    expect(li.posts[0]!.body.content).toEqual({ multiImage: { images: [...li.images.keys()].map((id) => ({ id })) } });
    expect(li.images.size).toBe(3);
  });

  it("uploads a video in parts read by byte range, waits while LinkedIn processes it, then posts it", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u);
    const video = await addMedia(u, { type: "VIDEO", width: 1920, height: 1080, durationSec: 45, bytes: FAKE_VIDEO.length });
    li.videoStatuses = ["PROCESSING", "AVAILABLE"];
    const res = await createPost(u, { caption: "Product demo", mediaIds: [video.id], targets: [{ socialAccountId: account.id }] });
    expect(res.body.post.targets[0].format).toBe("VIDEO");

    expect(await runPublishCycle()).toEqual(["waiting"]);
    const [[urn, uploaded]] = [...li.videos.entries()];
    expect(uploaded!.parts.size).toBe(3);
    // Buffer.equals: a deep comparison of 9 MB is very slow.
    expect(Buffer.concat([...uploaded!.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b)).equals(FAKE_VIDEO)).toBe(true);
    expect(uploaded!.finalized).toBe(true);
    expect(li.posts).toHaveLength(0);

    await fastForward();
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(li.posts[0]!.body.content).toEqual({ media: { id: urn } });
    // Uploaded once, even though it was checked twice.
    expect(li.calls.filter((c) => c === "POST api.linkedin.com/rest/videos")).toHaveLength(2); // initialize + finalize
    expect(li.videos.size).toBe(1);
  });

  it("goes ahead when the app can't read video status, and fails clearly when processing fails", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u);
    const video = await addMedia(u, { type: "VIDEO", durationSec: 30, bytes: FAKE_VIDEO.length });
    li.videoStatusForbidden = true;
    const ok = await createPost(u, { caption: "Clip", mediaIds: [video.id], targets: [{ socialAccountId: account.id }] });
    expect(await runPublishCycle()).toEqual(["published"]);
    expect((await targetOf(ok.body.post.id)).status).toBe("PUBLISHED");

    li.videoStatusForbidden = false;
    li.videoStatuses = ["PROCESSING_FAILED"];
    const bad = await createPost(u, { caption: "Broken clip", mediaIds: [video.id], targets: [{ socialAccountId: account.id }] });
    expect(await runPublishCycle()).toEqual(["failed"]);
    expect(await targetOf(bad.body.post.id)).toMatchObject({ status: "FAILED", lastErrorCode: "MEDIA_REJECTED", lastError: "LinkedIn couldn't process the video: Unsupported codec" });
  });

  it("waits and tries again when LinkedIn hasn't finished a photo, without uploading it again", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u);
    li.notReady = 1;
    const res = await createPost(u, { caption: "Launch", mediaIds: [(await addMedia(u)).id], targets: [{ socialAccountId: account.id }] });

    expect(await runPublishCycle()).toEqual(["waiting"]);
    await fastForward();
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(li.images.size).toBe(1);
    expect((await targetOf(res.body.post.id)).status).toBe("PUBLISHED");
  });

  it("never posts twice: if LinkedIn may have created the post, it stops and asks the user to check", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u);
    // LinkedIn creates the post but the answer never arrives.
    li.failures.push({ match: "POST /rest/posts", status: 504, body: { message: "Gateway timeout" }, thenCreate: true });
    const res = await createPost(u, { caption: "Once only", targets: [{ socialAccountId: account.id }] });

    expect(await runPublishCycle()).toEqual(["retry_scheduled"]);
    await fastForward();
    expect(await runPublishCycle()).toEqual(["failed"]);
    expect(li.posts).toHaveLength(1);
    expect((await targetOf(res.body.post.id)).lastError).toContain("Couldn't confirm whether LinkedIn published this post");
  });

  it("retries safely after LinkedIn refuses a post, and asks for a reconnect when access is rejected", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u);
    li.failures.push({ match: "POST /rest/posts", status: 429, body: { status: 429, message: "Too many requests" } });
    const res = await createPost(u, { caption: "Busy day", targets: [{ socialAccountId: account.id }] });
    expect(await runPublishCycle()).toEqual(["retry_scheduled"]);
    await fastForward();
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(li.posts).toHaveLength(1);
    expect((await targetOf(res.body.post.id)).status).toBe("PUBLISHED");

    li.validTokens.clear();
    const second = await createPost(u, { caption: "After a password change", targets: [{ socialAccountId: account.id }] });
    expect(await runPublishCycle()).toEqual(["failed"]);
    expect((await targetOf(second.body.post.id)).lastErrorCode).toBe("TOKEN_INVALID");
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("NEEDS_REAUTH");
  });

  it("checks LinkedIn's rules before saving, naming the profile in messages", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u);
    const target = [{ socialAccountId: account.id }];

    const mixed = await createPost(u, { caption: "Mix", mediaIds: [(await addMedia(u)).id, (await addMedia(u, { type: "VIDEO", bytes: FAKE_VIDEO.length })).id], targets: target });
    expect(mixed.status).toBe(400);
    expect(JSON.stringify(mixed.body.error.details)).toContain("Pragya Rajput: LinkedIn posts can have several photos or one video, not both.");

    const mov = await createPost(u, { caption: "Clip", mediaIds: [(await addMedia(u, { type: "VIDEO", format: "mov", bytes: FAKE_VIDEO.length })).id], targets: target });
    expect(JSON.stringify(mov.body.error.details)).toContain("LinkedIn videos must be MP4.");

    const long = await createPost(u, { caption: "x".repeat(3001), targets: target });
    expect(JSON.stringify(long.body.error.details)).toContain("Text is 3,001 characters; LinkedIn allows 3,000.");

    const shortVideo = await createPost(u, { caption: "Blink", mediaIds: [(await addMedia(u, { type: "VIDEO", durationSec: 2, bytes: FAKE_VIDEO.length })).id], targets: target });
    expect(JSON.stringify(shortVideo.body.error.details)).toContain("between 3 seconds and 30 minutes");
  });
});

describe("LinkedIn and analytics", () => {
  it("leaves LinkedIn out of analytics, and says so", async () => {
    const u = await signUp();
    await connectLinkedIn(u);
    const onlyLinkedIn = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/analytics/overview`).set(auth(u));
    expect(onlyLinkedIn.body).toEqual({ accounts: [], account: null, withoutAnalytics: ["LINKEDIN"] });

    const ig = await connectAccount(u);
    const both = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/analytics/overview`).set(auth(u));
    expect(both.body.accounts.map((a: { id: string }) => a.id)).toEqual([ig.id]);
    expect(both.body.withoutAnalytics).toEqual(["LINKEDIN"]);
  });
});

// ─── Keeping access ─────────────────────────────────────────────────────────

describe("LinkedIn access", () => {
  it("isn't touched by the refresh job, and needs a reconnect once it expires", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u, { expiresAt: new Date(Date.now() + 5 * DAY) });
    expect(await refreshDueTokens()).toMatchObject({ checked: 1, refreshed: 0, skipped: 1, needsReauth: 0 });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("ACTIVE");

    expect(await refreshDueTokens(new Date(Date.now() + 6 * DAY))).toMatchObject({ needsReauth: 1 });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("NEEDS_REAUTH");
  });

  it("renews access itself when LinkedIn issued a refresh token", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u, { expiresAt: new Date(Date.now() + 5 * DAY), refreshToken: "li-refresh" });
    expect(await refreshDueTokens()).toMatchObject({ refreshed: 1 });
    const token = await prisma.oAuthToken.findUniqueOrThrow({ where: { socialAccountId: account.id } });
    expect(decryptToken(token.accessTokenEnc)).toBe("li-token-2");
    expect(decryptToken(token.refreshTokenEnc!)).toBe("li-refresh-2");
    expect(token.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
  });

  it("is checked daily against the member it belongs to", async () => {
    const u = await signUp();
    const account = await connectLinkedIn(u);
    li.member.name = "Pragya R.";
    await prisma.socialAccount.update({ where: { id: account.id }, data: { lastCheckedAt: new Date(Date.now() - 2 * DAY) } });
    expect(await runConnectionHealthChecks()).toMatchObject({ checked: 1, ok: 1 });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).name).toBe("Pragya R.");

    li.member.sub = "someone-else";
    await prisma.socialAccount.update({ where: { id: account.id }, data: { lastCheckedAt: new Date(Date.now() - 2 * DAY) } });
    expect(await runConnectionHealthChecks()).toMatchObject({ needsReauth: 1 });
  });
});
