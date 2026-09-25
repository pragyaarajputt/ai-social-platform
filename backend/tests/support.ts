// Shared test support: a fake Instagram Graph API, Cloudinary and Claude API (installed over global fetch), and
// helpers to create users, connected accounts, media and posts.
import request from "supertest";
import { expect, vi } from "vitest";
import { app } from "../src/app.js";
import { prisma } from "../src/config/database.js";
import { env } from "../src/config/env.js";
import { encryptToken } from "../src/utils/tokenCrypto.js";

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
  claude: {
    /** Request bodies sent to the Claude API, with their beta header. */
    requests: { body: Record<string, any>; beta: string | null }[];
    /** Responses for the next calls, in order; when empty, a plain OK reply is used. */
    replies: Response[];
  };
}
export let fake: Fake;

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
  };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));

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

export async function connectAccount(u: User, opts: { externalId?: string; username?: string; status?: "ACTIVE" | "NEEDS_REAUTH" } = {}) {
  return prisma.socialAccount.create({
    data: {
      workspaceId: u.workspaceId,
      platform: "INSTAGRAM",
      externalId: opts.externalId ?? IG_USER,
      accountType: "BUSINESS",
      username: opts.username ?? "brand",
      status: opts.status ?? "ACTIVE",
      connectedById: u.userId,
      token: { create: { accessTokenEnc: encryptToken("ig-token"), expiresAt: new Date(Date.now() + 50 * 86_400_000), scopes: [] } },
    },
  });
}

export async function addMedia(u: User, m: { type?: "IMAGE" | "VIDEO"; width?: number; height?: number; durationSec?: number; format?: string } = {}) {
  const type = m.type ?? "IMAGE";
  const publicId = `ai-social/${u.workspaceId}/${crypto.randomUUID()}`;
  return prisma.mediaAsset.create({
    data: {
      workspaceId: u.workspaceId,
      publicId,
      type,
      format: m.format ?? (type === "VIDEO" ? "mp4" : "png"),
      bytes: 1_000_000,
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
