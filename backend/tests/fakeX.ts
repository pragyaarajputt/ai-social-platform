// A fake X (api.x.com OAuth 2.0, users/me, media upload and posts), used through the fetch mock in
// support.ts. The login code is "x-good-code"; the user's first tokens are "x-token" / "x-refresh".
import { createHash } from "node:crypto";
import { env } from "../src/config/env.js";

export const X_USER = "1500000000000000001";
export const X_TOKEN = "x-token";
export const X_REFRESH = "x-refresh";

interface FakeUpload {
  category: string;
  totalBytes?: number;
  chunks: Map<number, Buffer>;
  finalized: boolean;
  /** States returned by finalize and then by successive status checks; the last one repeats. */
  states: string[];
}

export interface FakeX {
  user: { id: string; username: string; name: string; profile_image_url: string };
  /** Access tokens X accepts. */
  validTokens: Set<string>;
  /** The one refresh token X currently accepts (each refresh replaces it). */
  refreshToken: string | null;
  /** Number of successful refreshes. */
  refreshes: number;
  /** The code_challenge from the authorization URL; the code exchange must present its verifier. */
  codeChallenge: string | null;
  uploads: Map<string, FakeUpload>;
  /** Processing states for new videos (default: nothing to process). */
  videoStates: string[];
  posts: { id: string; body: Record<string, any>; token: string }[];
  /** Answer the next calls whose "METHOD path" contains `match` (with `afterPosts`: once that many posts exist). */
  failures: { match: string; status: number; body: unknown; afterPosts?: number }[];
  /** "METHOD path" of every call. */
  calls: string[];
}

export let xf: FakeX;

export function resetX() {
  xf = {
    user: { id: X_USER, username: "pragya_builds", name: "Pragya Rajput", profile_image_url: "https://pbs.twimg.example/p.jpg" },
    validTokens: new Set([X_TOKEN]),
    refreshToken: X_REFRESH,
    refreshes: 0,
    codeChallenge: null,
    uploads: new Map(),
    videoStates: [],
    posts: [],
    failures: [],
    calls: [],
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const problem = (status: number, title: string, detail: string) => json(status, { title, detail, type: "about:blank", status });

let seq = 0;

function processingInfo(upload: FakeUpload) {
  const state = upload.states.length > 1 ? upload.states.shift()! : upload.states[0];
  if (!state) return undefined;
  return { state, check_after_secs: 3, ...(state === "failed" ? { error: { code: 1, name: "InvalidMedia", message: "Unsupported codec" } } : {}) };
}

/** Handles a request if it's for X; returns null otherwise. */
export async function handleX(url: URL, init?: RequestInit): Promise<Response | null> {
  if (url.host !== "api.x.com") return null;
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  const path = url.pathname + url.search;
  xf.calls.push(`${method} ${url.pathname}`);

  const failure = xf.failures.findIndex((f) => `${method} ${path}`.includes(f.match) && xf.posts.length >= (f.afterPosts ?? 0));
  if (failure >= 0) {
    const f = xf.failures.splice(failure, 1)[0]!;
    return json(f.status, f.body);
  }

  if (url.pathname === "/2/oauth2/token" && method === "POST") {
    const app = env.x!;
    const basic = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`;
    if (headers.get("authorization") !== basic) return json(401, { error: "unauthorized_client", error_description: "Missing valid authorization header" });
    const form = new URLSearchParams(String(init?.body));
    if (form.get("grant_type") === "authorization_code") {
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (form.get("code") !== "x-good-code" || form.get("redirect_uri") !== app.redirectUri || challenge !== xf.codeChallenge) {
        return json(400, { error: "invalid_request", error_description: "Value passed for the authorization code was invalid." });
      }
      return json(200, { token_type: "bearer", expires_in: 7200, access_token: X_TOKEN, scope: "tweet.read tweet.write users.read media.write offline.access", refresh_token: X_REFRESH });
    }
    if (form.get("grant_type") === "refresh_token") {
      if (!xf.refreshToken || form.get("refresh_token") !== xf.refreshToken) {
        return json(400, { error: "invalid_request", error_description: "Value passed for the token was invalid." });
      }
      xf.refreshes++;
      const access = `x-token-${xf.refreshes + 1}`;
      xf.validTokens.add(access);
      xf.refreshToken = `x-refresh-${xf.refreshes + 1}`;
      return json(200, { token_type: "bearer", expires_in: 7200, access_token: access, scope: "tweet.read tweet.write users.read media.write offline.access", refresh_token: xf.refreshToken });
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  const token = headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token || !xf.validTokens.has(token)) return problem(401, "Unauthorized", "Unauthorized");

  if (url.pathname === "/2/users/me" && method === "GET") return json(200, { data: xf.user });

  if (url.pathname === "/2/media/upload" && method === "POST") {
    const form = init!.body as FormData;
    const media = form.get("media");
    if (!(media instanceof Blob) || form.get("media_category") !== "tweet_image") return problem(400, "Invalid Request", "media and media_category are required");
    const id = `${++seq}000000000001`;
    xf.uploads.set(id, { category: "tweet_image", chunks: new Map([[0, Buffer.from(await media.arrayBuffer())]]), finalized: true, states: [] });
    return json(200, { data: { id, media_key: `3_${id}`, size: media.size, expires_after_secs: 86400 } });
  }

  if (url.pathname === "/2/media/upload/initialize" && method === "POST") {
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    if (body.media_category !== "tweet_video" || body.media_type !== "video/mp4" || typeof body.total_bytes !== "number") {
      return problem(400, "Invalid Request", "Bad initialize request");
    }
    const id = `${++seq}000000000002`;
    xf.uploads.set(id, { category: "tweet_video", totalBytes: body.total_bytes, chunks: new Map(), finalized: false, states: [...xf.videoStates] });
    return json(200, { data: { id, media_key: `7_${id}`, expires_after_secs: 86400 } });
  }

  const chunked = /^\/2\/media\/upload\/([^/]+)\/(append|finalize)$/.exec(url.pathname);
  if (chunked && method === "POST") {
    const upload = xf.uploads.get(chunked[1]!);
    if (!upload) return problem(400, "Invalid Request", "Unknown media ID");
    if (chunked[2] === "append") {
      const form = init!.body as FormData;
      const media = form.get("media");
      if (!(media instanceof Blob)) return problem(400, "Invalid Request", "media is required");
      if (media.size > 8 * 1024 * 1024) return problem(400, "Invalid Request", "Segment too large");
      upload.chunks.set(Number(form.get("segment_index")), Buffer.from(await media.arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    const size = [...upload.chunks.values()].reduce((n, b) => n + b.length, 0);
    if (size !== upload.totalBytes) return problem(400, "Invalid Request", "File size mismatch");
    upload.finalized = true;
    return json(200, { data: { id: chunked[1], media_key: `7_${chunked[1]}`, size, expires_after_secs: 86400, processing_info: processingInfo(upload) } });
  }

  if (url.pathname === "/2/media/upload" && method === "GET" && url.searchParams.get("command") === "STATUS") {
    const upload = xf.uploads.get(url.searchParams.get("media_id") ?? "");
    if (!upload) return problem(400, "Invalid Request", "Unknown media ID");
    return json(200, { data: { id: url.searchParams.get("media_id"), processing_info: processingInfo(upload) } });
  }

  if (url.pathname === "/2/tweets" && method === "POST") {
    const body = JSON.parse(String(init!.body)) as Record<string, any>;
    const mediaIds: string[] = body.media?.media_ids ?? [];
    if (!body.text && mediaIds.length === 0) return problem(400, "Invalid Request", "text or media is required");
    if (mediaIds.length > 4) return problem(400, "Invalid Request", "Too many media");
    for (const id of mediaIds) {
      const upload = xf.uploads.get(id);
      if (!upload?.finalized || (upload.category === "tweet_video" && upload.states[0] && upload.states[0] !== "succeeded")) {
        return problem(400, "Invalid Request", `Your media IDs are invalid.`);
      }
    }
    const replyTo = body.reply?.in_reply_to_tweet_id;
    if (replyTo && !xf.posts.some((p) => p.id === replyTo)) return problem(400, "Invalid Request", "The post you're replying to doesn't exist");
    const id = `19000000000000${String(++seq).padStart(5, "0")}`;
    xf.posts.push({ id, body, token });
    return json(201, { data: { id, text: body.text ?? "", edit_history_post_ids: [id] } });
  }

  throw new Error(`Unexpected X call: ${method} ${path}`);
}
