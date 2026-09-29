// Shared test support: fake Instagram, Facebook (fakeFacebook.ts), LinkedIn (fakeLinkedIn.ts), Cloudinary and Claude APIs (installed over global fetch), and
// helpers to create users, connected accounts, media and posts.
import request from "supertest";
import { expect, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { encryptToken } from "../src/utils/tokenCrypto.js";
import { FB_PAGE, handleFacebook, PAGE_TOKEN, resetFacebook } from "./fakeFacebook.js";
import { handleLinkedIn, LI_MEMBER, LI_TOKEN, resetLinkedIn } from "./fakeLinkedIn.js";

export { fb, FB_PAGE, FB_USER } from "./fakeFacebook.js";
export { li, LI_MEMBER } from "./fakeLinkedIn.js";

// ─── Fake Instagram + Cloudinary ────────────────────────────────────────────

interface Container {
  params: Record<string, string>;
  /** Statuses returned by successive status checks; the last one repeats. */
  statuses: string[];
  published?: boolean;
}

interface Fake {
  containers: Map<string, Container>;
  media: { id: string; permalink: string; timestamp: string }[];
  createCalls: Record<string, string>[];
  publishCalls: string[];
  /** Status sequence for the next video containers (default: finished at once). */
  videoStatuses: string[];
  /** Respond to media_publish with these HTTP errors first. */
  publishFailures: { status: number; body: unknown }[];
  /** Respond to container creation with these errors first. */
  createFailures: { status: number; body: unknown }[];
  cloudinary: Map<string, Record<string, unknown>>;
  insights: {
    /** Media insight values by metric name (the same for every post). */
    media: Record<string, number>;
    /** Account insight values for the day starting at `since` (unix seconds). */
    accountDay: (since: number) => Record<string, number>;
    follows: number;
    unfollows: number;
    followers: number;
    /** online_followers values, as Instagram returns them. */
    online: { value: Record<string, number>; end_time: string }[];
    /** Media IDs that no longer exist on Instagram. */
    deleted: Set<string>;
    /** Answer every insights call with this error. */
    error: { status: number; body: unknown } | null;
    /** Every insights-related call: "media:<id>", "account:<metric>:<since>", "followers", "online". */
    calls: string[];
  };
  /** What /me returns for the connected Instagram account (the health check reads it). */
  profile: { userId: string; username: string };
  claude: {
    /** Request bodies sent to the Claude API, with their beta header. */
    requests: { body: Record<string, any>; beta: string | null }[];
    /** Responses for the next calls, in order; when empty, a plain OK reply is used. */
    replies: Response[];
  };
  gemini: {
    /** Requests sent to the Gemini API: model, API key header and body. */
    requests: { model: string; key: string | null; body: Record<string, any> }[];
    replies: Response[];
    /** Image downloads from res.cloudinary.com (Gemini gets photos inline). */
    imageFetches: string[];
  };
}
export let fake: Fake;

/** The bytes the fake Cloudinary serves for any image, so tests can check what was sent inline. */
export const FAKE_IMAGE = Buffer.from("fake-jpeg-bytes");
/** The file the fake Cloudinary serves for any video (9 MB, so LinkedIn splits it into three parts). */
export const FAKE_VIDEO = Buffer.alloc(9_000_000);
for (let i = 0; i < FAKE_VIDEO.length; i++) FAKE_VIDEO[i] = i % 251;

export const IG_USER = "17841400000000001";
const V = () => env.instagram!.graphVersion;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function installFakes() {
  fake = {
    containers: new Map(),
    media: [],
    createCalls: [],
    publishCalls: [],
    videoStatuses: ["FINISHED"],
    publishFailures: [],
    createFailures: [],
    cloudinary: new Map(),
    claude: { requests: [], replies: [] },
    gemini: { requests: [], replies: [], imageFetches: [] },
    profile: { userId: IG_USER, username: "brand" },
    insights: {
      media: { views: 1200, reach: 800, likes: 90, comments: 12, shares: 7, saved: 15, total_interactions: 124, profile_visits: 20, follows: 3, ig_reels_avg_watch_time: 6400 },
      accountDay: () => ({ reach: 500, views: 900, accounts_engaged: 60, total_interactions: 80, likes: 50, comments: 10, shares: 5, saves: 15, profile_links_taps: 4 }),
      follows: 6,
      unfollows: 2,
      followers: 1520,
      online: [],
      deleted: new Set(),
      error: null,
      calls: [],
    },
  };
  resetFacebook();
  resetLinkedIn();
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    if (url.host === "generativelanguage.googleapis.com") {
      const m = /\/models\/([^/:]+):generateContent$/.exec(url.pathname);
      if (!m) throw new Error(`Unexpected Gemini call: ${url.pathname}`);
      const key = new Headers(init?.headers).get("x-goog-api-key");
      fake.gemini.requests.push({ model: m[1]!, key, body: JSON.parse(String(init?.body)) });
      if (key !== env.ai.gemini.apiKey) return json(400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } });
      return fake.gemini.replies.shift() ?? geminiReply({ captions: [{ text: "ok" }] });
    }
    if (url.host === "res.cloudinary.com" && url.pathname.includes("/video/upload/")) {
      // Honors byte ranges, as Cloudinary does.
      const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get("range") ?? "");
      if (!range) return new Response(FAKE_VIDEO, { status: 200, headers: { "Content-Type": "video/mp4" } });
      return new Response(FAKE_VIDEO.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206, headers: { "Content-Type": "video/mp4" } });
    }
    if (url.host === "res.cloudinary.com") {
      fake.gemini.imageFetches.push(url.toString());
      return new Response(FAKE_IMAGE, { status: 200, headers: { "Content-Type": "image/jpeg" } });
    }

    const facebook = handleFacebook(url, init);
    if (facebook) return facebook;
    const linkedin = handleLinkedIn(url, init);
    if (linkedin) return linkedin;

    if (url.host === "api.cloudinary.com") {
      const expectedAuth = `Basic ${Buffer.from(`${env.cloudinary!.apiKey}:${env.cloudinary!.apiSecret}`).toString("base64")}`;
      if ((init?.headers as Record<string, string>)?.Authorization !== expectedAuth) return json(401, { error: { message: "bad auth" } });
      const m = /^\/v1_1\/test-cloud\/resources\/(image|video)\/upload\/(.+)$/.exec(url.pathname);
      const resource = m ? fake.cloudinary.get(decodeURIComponent(m[2]!)) : undefined;
      return resource && resource.resource_type === m![1] ? json(200, resource) : json(404, { error: { message: "not found" } });
    }

    if (url.host === "api.anthropic.com") {
      const headers = new Headers(init?.headers);
      if (headers.get("x-api-key") !== env.ai.apiKey) return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      fake.claude.requests.push({ body: JSON.parse(String(init?.body)), beta: headers.get("anthropic-beta") });
      return fake.claude.replies.shift() ?? claudeReply({ captions: [{ text: "ok" }] });
    }

    if (url.host === "graph.instagram.com") {
      const path = url.pathname.replace(`/${V()}/`, "");
      const form = init?.body ? new URLSearchParams(String(init.body)) : url.searchParams;
      if (form.get("access_token") !== "ig-token") return json(400, { error: { message: "Invalid OAuth access token", code: 190 } });

      if (path === `${IG_USER}/media` && init?.method === "POST") {
        const failure = fake.createFailures.shift();
        if (failure) return json(failure.status, failure.body);
        const params = Object.fromEntries([...form.entries()].filter(([k]) => k !== "access_token"));
        fake.createCalls.push(params);
        const id = `c${fake.containers.size + 1}`;
        const isVideo = params.media_type === "REELS" || params.media_type === "VIDEO";
        fake.containers.set(id, { params, statuses: isVideo ? [...fake.videoStatuses] : ["FINISHED"] });
        return json(200, { id });
      }
      if (path === `${IG_USER}/media_publish`) {
        const failure = fake.publishFailures.shift();
        if (failure) return json(failure.status, failure.body);
        const containerId = form.get("creation_id")!;
        fake.publishCalls.push(containerId);
        const container = fake.containers.get(containerId);
        if (!container || container.published) return json(400, { error: { message: "Media already published", code: 9007 } });
        container.published = true;
        const id = `m${fake.media.length + 1}`;
        fake.media.unshift({ id, permalink: `https://www.instagram.com/p/${id}/`, timestamp: new Date().toISOString() });
        return json(200, { id });
      }
      if (path === `${IG_USER}/media`) return json(200, { data: fake.media });
      if (path === "me") {
        return json(200, { id: "app-scoped-1", user_id: fake.profile.userId, username: fake.profile.username, account_type: "BUSINESS", profile_picture_url: "https://ig.example/p.jpg" });
      }

      // Insights
      const ins = fake.insights;
      const mediaInsights = /^(m\d+)\/insights$/.exec(path);
      const isInsights = mediaInsights || path === `${IG_USER}/insights` || (path === IG_USER && form.get("fields") === "followers_count");
      if (isInsights && ins.error) {
        ins.calls.push(`error:${path}`);
        return json(ins.error.status, ins.error.body);
      }
      if (mediaInsights) {
        ins.calls.push(`media:${mediaInsights[1]}`);
        if (ins.deleted.has(mediaInsights[1]!)) return json(400, { error: { message: "Media does not exist", code: 100, error_subcode: 33 } });
        const metrics = form.get("metric")!.split(",");
        return json(200, { data: metrics.map((name) => ({ name, period: "lifetime", values: [{ value: ins.media[name] ?? 0 }] })) });
      }
      if (path === `${IG_USER}/insights`) {
        const metric = form.get("metric")!;
        if (metric === "online_followers") {
          ins.calls.push("online");
          return json(200, { data: [{ name: "online_followers", period: "lifetime", values: ins.online }] });
        }
        const since = Number(form.get("since"));
        ins.calls.push(`account:${metric === "follows_and_unfollows" ? "follows" : "main"}:${since}`);
        if (form.get("metric_type") !== "total_value" || Number(form.get("until")) - since !== 86_400) return json(400, { error: { message: "bad range", code: 100 } });
        if (metric === "follows_and_unfollows") {
          return json(200, {
            data: [{ name: metric, period: "day", total_value: { value: ins.follows + ins.unfollows, breakdowns: [{ dimension_keys: ["follow_type"], results: [
              { dimension_values: ["FOLLOWER"], value: ins.follows },
              { dimension_values: ["NON_FOLLOWER"], value: ins.unfollows },
            ] }] } }],
          });
        }
        const values = ins.accountDay(since);
        return json(200, { data: metric.split(",").map((name) => ({ name, period: "day", total_value: { value: values[name] ?? 0 } })) });
      }
      if (path === IG_USER && form.get("fields") === "followers_count") {
        ins.calls.push("followers");
        return json(200, { id: IG_USER, followers_count: ins.followers });
      }
      const container = fake.containers.get(path);
      if (container) {
        const statusCode = container.published ? "PUBLISHED" : container.statuses.length > 1 ? container.statuses.shift()! : container.statuses[0]!;
        return json(200, { id: path, status_code: statusCode, status: statusCode === "ERROR" ? "Unsupported codec" : undefined });
      }
      const media = fake.media.find((m) => m.id === path);
      if (media) return json(200, { id: media.id, permalink: media.permalink });
      throw new Error(`Unexpected Instagram call: ${path}`);
    }
    return realFetch(input, init);
  });
}

/** A Claude Messages API response whose text is `output` as JSON (what structured outputs return). */
export function claudeReply(
  output: unknown,
  opts: { stopReason?: string; model?: string; usage?: Partial<Record<"input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens", number>> } = {},
) {
  return json(200, {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: opts.model ?? "claude-opus-5",
    content: opts.stopReason === "refusal" ? [] : [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
    stop_reason: opts.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...opts.usage },
  });
}

export function claudeError(status: number, type: string) {
  return json(status, { type: "error", error: { type, message: type } });
}

/** A Gemini generateContent response whose text is `output` as JSON. */
export function geminiReply(
  output: unknown,
  opts: { finishReason?: string; blockReason?: string; modelVersion?: string; usage?: Record<string, number> } = {},
) {
  return json(200, {
    candidates: opts.blockReason
      ? []
      : [{ content: { role: "model", parts: [{ text: typeof output === "string" ? output : JSON.stringify(output) }] }, finishReason: opts.finishReason ?? "STOP", index: 0 }],
    ...(opts.blockReason && { promptFeedback: { blockReason: opts.blockReason } }),
    usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 150, thoughtsTokenCount: 50, cachedContentTokenCount: 200, totalTokenCount: 1400, ...opts.usage },
    modelVersion: opts.modelVersion ?? "gemini-3.8-flash",
  });
}

export function geminiError(status: number, message: string, statusText = "UNAVAILABLE") {
  return json(status, { error: { code: status, message, status: statusText } });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let seq = 0;
export async function signUp() {
  seq += 1;
  const id = `${Date.now().toString(36)}${seq}`;
  const res = await request(app)
    .post("/api/v1/auth/register")
    .send({ email: `pub${id}@example.test`, username: `pub_${id}`, password: "correct horse battery", displayName: "Publisher" });
  expect(res.status).toBe(201);
  const token = res.body.accessToken as string;
  const ws = await request(app).get("/api/v1/workspaces").set("Authorization", `Bearer ${token}`);
  return { token, userId: res.body.user.id as string, workspaceId: ws.body.workspaces[0].id as string };
}
export type User = Awaited<ReturnType<typeof signUp>>;
export const auth = (u: User) => ({ Authorization: `Bearer ${u.token}` });

export async function connectAccount(u: User, opts: { externalId?: string; username?: string; status?: "ACTIVE" | "NEEDS_REAUTH"; insightsAllowed?: boolean } = {}) {
  return prisma.socialAccount.create({
    data: {
      workspaceId: u.workspaceId,
      platform: "INSTAGRAM",
      externalId: opts.externalId ?? IG_USER,
      accountType: "BUSINESS",
      username: opts.username ?? "brand",
      status: opts.status ?? "ACTIVE",
      insightsAllowed: opts.insightsAllowed ?? true,
      connectedById: u.userId,
      token: { create: { accessTokenEnc: encryptToken("ig-token"), expiresAt: new Date(Date.now() + 50 * 86_400_000), scopes: [] } },
    },
  });
}

/** A connected Facebook Page (the fake's Page, with its Page token that doesn't expire). */
export async function connectPage(u: User, opts: { status?: "ACTIVE" | "NEEDS_REAUTH" } = {}) {
  return prisma.socialAccount.create({
    data: {
      workspaceId: u.workspaceId,
      platform: "FACEBOOK",
      externalId: FB_PAGE,
      appScopedId: "fb-app-scoped-user-1",
      accountType: "PAGE",
      username: "punecafe",
      name: "Pune Cafe",
      status: opts.status ?? "ACTIVE",
      insightsAllowed: true,
      connectedById: u.userId,
      token: { create: { accessTokenEnc: encryptToken(PAGE_TOKEN), expiresAt: null, scopes: ["pages_manage_posts", "read_insights"] } },
    },
  });
}

/** A connected LinkedIn profile (the fake member). Without a refresh token, its access can only be renewed by reconnecting. */
export async function connectLinkedIn(u: User, opts: { expiresAt?: Date; refreshToken?: string; status?: "ACTIVE" | "NEEDS_REAUTH" } = {}) {
  return prisma.socialAccount.create({
    data: {
      workspaceId: u.workspaceId,
      platform: "LINKEDIN",
      externalId: LI_MEMBER,
      accountType: "PERSON",
      name: "Pragya Rajput",
      status: opts.status ?? "ACTIVE",
      insightsAllowed: false,
      connectedById: u.userId,
      token: {
        create: {
          accessTokenEnc: encryptToken(LI_TOKEN),
          refreshTokenEnc: opts.refreshToken ? encryptToken(opts.refreshToken) : null,
          expiresAt: opts.expiresAt ?? new Date(Date.now() + 50 * 86_400_000),
          scopes: ["openid", "profile", "w_member_social"],
        },
      },
    },
  });
}

export async function addMedia(u: User, m: { type?: "IMAGE" | "VIDEO"; width?: number; height?: number; durationSec?: number; format?: string; bytes?: number } = {}) {
  const type = m.type ?? "IMAGE";
  const publicId = `ai-social/${u.workspaceId}/${crypto.randomUUID()}`;
  return prisma.mediaAsset.create({
    data: {
      workspaceId: u.workspaceId,
      publicId,
      type,
      format: m.format ?? (type === "VIDEO" ? "mp4" : "png"),
      bytes: m.bytes ?? 1_000_000,
      width: m.width ?? 1080,
      height: m.height ?? 1080,
      durationSec: m.durationSec ?? (type === "VIDEO" ? 20 : null),
      secureUrl: `https://res.cloudinary.com/test-cloud/${type === "VIDEO" ? "video" : "image"}/upload/v1/${publicId}.${type === "VIDEO" ? "mp4" : "png"}`,
    },
  });
}

export async function createPost(u: User, body: object) {
  return request(app).post(`/api/v1/workspaces/${u.workspaceId}/posts`).set(auth(u)).send(body);
}

/** Makes every queued/waiting target due now, as if time had passed. */
export async function fastForward() {
  await prisma.postTarget.updateMany({ where: { status: { in: ["QUEUED", "WAITING_FOR_MEDIA"] } }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
}

export const targetOf = (postId: string) => prisma.postTarget.findFirstOrThrow({ where: { postId } });
