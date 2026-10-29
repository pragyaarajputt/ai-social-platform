import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { runConnectionHealthChecks } from "../src/jobs/connectionHealth.js";
import { runPublishCycle } from "../src/jobs/publishQueue.js";
import { newTid } from "../src/integrations/bluesky/client.js";
import { detectFacets, graphemeLength, splitThread } from "../src/integrations/bluesky/text.js";
import { refreshDueTokens } from "../src/services/tokenRefresh.service.js";
import { decryptToken } from "../src/utils/tokenCrypto.js";
import {
  addMedia,
  auth,
  bf,
  BSKY_APP_PASSWORD,
  BSKY_DID,
  BSKY_HANDLE,
  connectBluesky,
  createPost,
  FAKE_IMAGE,
  fastForward,
  installFakes,
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

const HOUR = 3_600_000;
const sentence = (n: number) => `Sentence number ${n} explains one more idea about scheduling posts on Bluesky.`;
const records = () => [...bf.posts.values()].map((p) => p.record);

// ─── Text ───────────────────────────────────────────────────────────────────

describe("Bluesky text", () => {
  it("counts what people see as characters, and splits long text into a thread of 300-character posts", () => {
    expect(graphemeLength("👩🏽‍💻 é")).toBe(3);
    expect(splitThread("Short and sweet")).toEqual(["Short and sweet"]);
    const posts = splitThread(Array.from({ length: 10 }, (_, i) => sentence(i + 1)).join(" "));
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.every((p, i) => graphemeLength(p) <= 300 && p.endsWith(` ${i + 1}/${posts.length}`))).toBe(true);
  });

  it("marks links, mentions and hashtags by UTF-8 byte offsets", async () => {
    const text = "🎉 Launch day with @friend.bsky.social and @nobody.example.com: https://postdrip.app/x. #BuildInPublic";
    const facets = await detectFacets(text, async (h) => (h === "friend.bsky.social" ? "did:plc:friend" : null));
    const bytes = Buffer.from(text);
    const at = (f: (typeof facets)[number]) => bytes.subarray(f.index.byteStart, f.index.byteEnd).toString();
    expect(facets.map((f) => [at(f), f.features[0]])).toEqual([
      ["@friend.bsky.social", { $type: "app.bsky.richtext.facet#mention", did: "did:plc:friend" }],
      // The full stop after the link isn't part of it.
      ["https://postdrip.app/x", { $type: "app.bsky.richtext.facet#link", uri: "https://postdrip.app/x" }],
      ["#BuildInPublic", { $type: "app.bsky.richtext.facet#tag", tag: "BuildInPublic" }],
    ]);
  });

  it("makes record keys in the TID format, always increasing", () => {
    const keys = Array.from({ length: 50 }, () => newTid(1_800_000_000_000));
    expect(keys.every((k) => /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(k))).toBe(true);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(50);
  });
});

// ─── Connecting ─────────────────────────────────────────────────────────────

describe("connecting Bluesky with an app password", () => {
  const connect = (u: User, body: object) => request(app).post(`/api/v1/workspaces/${u.workspaceId}/social-accounts/bluesky/app-password`).set(auth(u)).send(body);

  it("signs in on the account's own server, stores only the session tokens, and lists the account", async () => {
    const u = await signUp();
    const res = await connect(u, { identifier: `@${BSKY_HANDLE}`, appPassword: BSKY_APP_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.accounts[0]).toMatchObject({ platform: "BLUESKY", externalId: BSKY_DID, username: BSKY_HANDLE, name: "Pragya Rajput" });
    // The handle led to the account's server, and that's where it signed in.
    expect(bf.calls).toContain("POST pds.example.test/xrpc/com.atproto.server.createSession");

    const account = await prisma.socialAccount.findFirstOrThrow({ where: { workspaceId: u.workspaceId }, include: { token: true } });
    expect(decryptToken(account.token!.refreshTokenEnc!)).toBe("bsky-refresh-1");
    expect(account.token!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 1.9 * HOUR);
    // The app password itself is never stored.
    const everything = JSON.stringify(await prisma.$queryRawUnsafe("SELECT * FROM oauth_tokens")) + JSON.stringify(await prisma.$queryRawUnsafe("SELECT * FROM audit_logs"));
    expect(everything).not.toContain(BSKY_APP_PASSWORD);

    const list = await request(app).get(`/api/v1/workspaces/${u.workspaceId}/social-accounts`).set(auth(u));
    expect(list.body.accounts[0]).toMatchObject({ platform: "BLUESKY", tokenRenews: true });
    expect(list.body.platforms).toContainEqual({ platform: "BLUESKY", displayName: "Bluesky", configured: true, connectMethod: "app_password" });
  });

  it("says clearly when the handle or app password is wrong", async () => {
    const u = await signUp();
    const res = await connect(u, { identifier: BSKY_HANDLE, appPassword: "wrong-pass-word-0000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: "SIGN_IN_FAILED" });
    expect(res.body.error.message).toContain("app password");
    expect(await prisma.socialAccount.count()).toBe(0);
  });

  it("is for admins only, and isn't a redirect flow", async () => {
    const u = await signUp();
    const redirect = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/social-accounts/bluesky/connect`).set(auth(u));
    expect(redirect.status).toBe(400);
    expect(redirect.body.error.code).toBe("WRONG_CONNECT_METHOD");
    const wrongPlatform = await request(app).post(`/api/v1/workspaces/${u.workspaceId}/social-accounts/x/app-password`).set(auth(u)).send({ identifier: "a", appPassword: "b" });
    expect(wrongPlatform.body.error.code).toBe("WRONG_CONNECT_METHOD");
  });
});

// ─── Publishing ─────────────────────────────────────────────────────────────

describe("publishing to Bluesky", () => {
  it("publishes a post with clickable links and hashtags, and links to it", async () => {
    const u = await signUp();
    const account = await connectBluesky(u);
    const res = await createPost(u, { caption: "Hello Bluesky! https://postdrip.app #launch", targets: [{ socialAccountId: account.id }] });
    expect(res.status).toBe(201);
    expect(res.body.post.targets[0]).toMatchObject({ format: "TEXT", account: { platform: "BLUESKY" } });

    expect(await runPublishCycle()).toEqual(["published"]);
    const [post] = [...bf.posts.values()];
    expect(post!.record).toMatchObject({ $type: "app.bsky.feed.post", text: "Hello Bluesky! https://postdrip.app #launch" });
    expect(post!.record.facets.map((f: { features: { $type: string }[] }) => f.features[0]!.$type)).toEqual(["app.bsky.richtext.facet#link", "app.bsky.richtext.facet#tag"]);
    expect(await targetOf(res.body.post.id)).toMatchObject({
      status: "PUBLISHED",
      externalPostId: `at://${BSKY_DID}/app.bsky.feed.post/${post!.rkey}`,
      permalink: `https://bsky.app/profile/${BSKY_DID}/post/${post!.rkey}`,
    });
  });

  it("publishes long text as a thread: each reply names the first post as root and the previous as parent", async () => {
    const u = await signUp();
    const account = await connectBluesky(u);
    const caption = Array.from({ length: 10 }, (_, i) => sentence(i + 1)).join(" ");
    await createPost(u, { caption, targets: [{ socialAccountId: account.id }] });

    expect(await runPublishCycle()).toEqual(["published"]);
    const posts = [...bf.posts.values()];
    expect(posts.map((p) => p.record.text)).toEqual(splitThread(caption));
    const ref = (p: (typeof posts)[number]) => ({ uri: `at://${BSKY_DID}/app.bsky.feed.post/${p.rkey}`, cid: p.cid });
    expect(posts[0]!.record.reply).toBeUndefined();
    for (let i = 1; i < posts.length; i++) expect(posts[i]!.record.reply).toEqual({ root: ref(posts[0]!), parent: ref(posts[i - 1]!) });
  });

  it("uploads photos and puts them on the first post, with their shape", async () => {
    const u = await signUp();
    const account = await connectBluesky(u);
    const photos = [await addMedia(u, { width: 1080, height: 1350 }), await addMedia(u)];
    const res = await createPost(u, { caption: "Team day\n---\nMore soon", mediaIds: photos.map((p) => p.id), targets: [{ socialAccountId: account.id }] });
    expect(res.body.post.targets[0].format).toBe("CAROUSEL");

    expect(await runPublishCycle()).toEqual(["published"]);
    const blobs = [...bf.blobs.entries()];
    expect(blobs.map(([, b]) => b.bytes.equals(FAKE_IMAGE))).toEqual([true, true]);
    const [first, second] = records();
    expect(first!.embed).toEqual({
      $type: "app.bsky.embed.images",
      images: [
        { image: { $type: "blob", ref: { $link: blobs[0]![0] }, mimeType: "image/jpeg", size: FAKE_IMAGE.length }, alt: "", aspectRatio: { width: 1080, height: 1350 } },
        { image: { $type: "blob", ref: { $link: blobs[1]![0] }, mimeType: "image/jpeg", size: FAKE_IMAGE.length }, alt: "", aspectRatio: { width: 1080, height: 1080 } },
      ],
    });
    expect(second!.embed).toBeUndefined();
  });

  it("finds a post that went through when the answer got lost, instead of posting it twice", async () => {
    const u = await signUp();
    const account = await connectBluesky(u);
    const res = await createPost(u, { caption: "One.\n---\nTwo.", targets: [{ socialAccountId: account.id }] });
    // The first post is created, but the connection drops before the answer arrives.
    bf.failures.push({ match: "POST /xrpc/com.atproto.repo.createRecord", status: 502, body: { error: "UpstreamFailure", message: "Bad gateway" }, thenCreate: true });

    expect(await runPublishCycle()).toEqual(["retry_scheduled"]);
    expect(bf.posts.size).toBe(1);
    await fastForward();
    expect(await runPublishCycle()).toEqual(["published"]);
    expect(records().map((r) => r.text)).toEqual(["One. 1/2", "Two. 2/2"]);
    expect((await targetOf(res.body.post.id)).status).toBe("PUBLISHED");
  });

  it("rejects what PostDrip can't post to Bluesky, before scheduling it", async () => {
    const u = await signUp();
    const account = await connectBluesky(u);
    const video = await createPost(u, { caption: "Clip", mediaIds: [(await addMedia(u, { type: "VIDEO" })).id], targets: [{ socialAccountId: account.id }] });
    expect(video.status).toBe(400);
    expect(JSON.stringify(video.body)).toContain("Videos can't be posted to Bluesky");
    const photos = await Promise.all(Array.from({ length: 5 }, () => addMedia(u)));
    const tooMany = await createPost(u, { caption: "Gallery", mediaIds: photos.map((p) => p.id), targets: [{ socialAccountId: account.id }] });
    expect(JSON.stringify(tooMany.body)).toContain("at most 4 photos");
  });
});

// ─── Keeping access ─────────────────────────────────────────────────────────

describe("Bluesky access renewal", () => {
  it("renews the session on the account's server before publishing when it's about to expire", async () => {
    const u = await signUp();
    const account = await connectBluesky(u, { expiresAt: new Date(Date.now() + 60_000) });
    await createPost(u, { caption: "Fresh session", targets: [{ socialAccountId: account.id }] });

    expect(await runPublishCycle()).toEqual(["published"]);
    expect(bf.refreshes).toBe(1);
    const token = await prisma.oAuthToken.findUniqueOrThrow({ where: { socialAccountId: account.id } });
    // The post was made with the renewed session, and Bluesky's replacement refresh token was kept.
    expect([...bf.posts.values()][0]!.token).toBe(decryptToken(token.accessTokenEnc));
    expect(JSON.parse(Buffer.from(decryptToken(token.accessTokenEnc).split(".")[1]!, "base64url").toString()).name).toBe("access-2");
    expect(decryptToken(token.refreshTokenEnc!)).toBe("bsky-refresh-2");
  });

  it("renews an expired session, and asks for a reconnect when the refresh token is revoked", async () => {
    const u = await signUp();
    const account = await connectBluesky(u, { expiresAt: new Date(Date.now() - HOUR) });
    expect(await refreshDueTokens()).toMatchObject({ refreshed: 1, needsReauth: 0 });

    bf.refreshToken = null; // e.g. the user deleted the app password
    await prisma.oAuthToken.update({ where: { socialAccountId: account.id }, data: { expiresAt: new Date(Date.now() - HOUR) } });
    expect(await refreshDueTokens()).toMatchObject({ needsReauth: 1 });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("NEEDS_REAUTH");
  });

  it("checks the session in the daily health check", async () => {
    const u = await signUp();
    const account = await connectBluesky(u);
    expect(await runConnectionHealthChecks()).toMatchObject({ ok: 1, needsReauth: 0 });
    expect((await prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).avatarUrl).toBe("https://cdn.bsky.example/avatar.jpg");
  });
});
