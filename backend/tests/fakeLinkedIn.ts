// A fake LinkedIn (www.linkedin.com OAuth and uploads, api.linkedin.com REST), used through the fetch
// mock in support.ts. The login code is "li-good-code"; the member's token is "li-token".
import { env } from "../src/config/env.js";

export const LI_MEMBER = "li-member-1";
export const LI_TOKEN = "li-token";
const PART_BYTES = 4 * 1024 * 1024;

interface FakeVideo {
  owner: string;
  size: number;
  parts: Map<number, Buffer>;
  finalized: boolean;
  /** Status returned by successive status checks; the last one repeats. */
  statuses: string[];
}

export interface FakeLinkedIn {
  member: { sub: string; name: string; picture: string };
  /** Tokens LinkedIn accepts. */
  validTokens: Set<string>;
  /** Extra fields in the code-exchange response (e.g. a refresh token). */
  tokenExtras: Record<string, unknown>;
  images: Map<string, { owner: string; bytes?: Buffer }>;
  videos: Map<string, FakeVideo>;
  /** Status sequence for new videos (default: available at once). */
  videoStatuses: string[];
  /** Answer video status checks with 403, as for apps that can't read them. */
  videoStatusForbidden: boolean;
  /** Reject this many post creations with "media not ready yet". */
  notReady: number;
  posts: { id: string; body: Record<string, any> }[];
  /** Answer the next calls whose "METHOD path" contains `match`. With `thenCreate`, the post is created first. */
  failures: { match: string; status: number; body: unknown; thenCreate?: boolean }[];
  /** "METHOD host/path" of every call. */
  calls: string[];
  /** Headers of every REST call, to check the API version. */
  restHeaders: Headers[];
}

export let li: FakeLinkedIn;

export function resetLinkedIn() {
  li = {
    member: { sub: LI_MEMBER, name: "Pragya Rajput", picture: "https://media.licdn.example/p.jpg" },
    validTokens: new Set([LI_TOKEN]),
    tokenExtras: {},
    images: new Map(),
    videos: new Map(),
    videoStatuses: ["AVAILABLE"],
    videoStatusForbidden: false,
    notReady: 0,
    posts: [],
    failures: [],
    calls: [],
    restHeaders: [],
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
const apiError = (status: number, code: string, message: string) => json(status, { status, serviceErrorCode: 100, code, message });

let seq = 0;

/** Handles a request if it's for LinkedIn; returns null otherwise. */
export function handleLinkedIn(url: URL, init?: RequestInit): Response | null {
  if (url.host !== "www.linkedin.com" && url.host !== "api.linkedin.com") return null;
  const method = init?.method ?? "GET";
  const headers = new Headers(init?.headers);
  const path = url.pathname + url.search;
  li.calls.push(`${method} ${url.host}${url.pathname}`);

  const failure = li.failures.findIndex((f) => `${method} ${path}`.includes(f.match));
  if (failure >= 0) {
    const f = li.failures.splice(failure, 1)[0]!;
    if (f.thenCreate) createPost(JSON.parse(String(init!.body)));
    return json(f.status, f.body);
  }

  if (url.host === "www.linkedin.com" && url.pathname === "/oauth/v2/accessToken") {
    const form = new URLSearchParams(String(init?.body));
    const app = env.linkedin!;
    if (form.get("client_id") !== app.clientId || form.get("client_secret") !== app.clientSecret) {
      return json(401, { error: "invalid_client", error_description: "Client authentication failed" });
    }
    if (form.get("grant_type") === "authorization_code") {
      if (form.get("code") !== "li-good-code" || form.get("redirect_uri") !== app.redirectUri) {
        return json(400, { error: "invalid_request", error_description: "Unable to retrieve access token: authorization code not found" });
      }
      return json(200, { access_token: LI_TOKEN, expires_in: 5_184_000, scope: "openid,profile,w_member_social", ...li.tokenExtras });
    }
    if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "li-refresh") {
      li.validTokens.add("li-token-2");
      return json(200, { access_token: "li-token-2", expires_in: 5_184_000, refresh_token: "li-refresh-2", scope: "openid,profile,w_member_social" });
    }
    return json(400, { error: "invalid_grant", error_description: "bad refresh token" });
  }

  // Uploads: PUT to the URLs handed out by initializeUpload.
  if (url.host === "www.linkedin.com" && url.pathname.startsWith("/dms-uploads/") && method === "PUT") {
    if (headers.get("authorization") !== `Bearer ${LI_TOKEN}`) return apiError(401, "INVALID_ACCESS_TOKEN", "Invalid access token");
    const bytes = Buffer.from(init!.body as Uint8Array);
    const [, , id] = url.pathname.split("/");
    const image = li.images.get(`urn:li:image:${id}`);
    if (image) {
      image.bytes = bytes;
      return new Response(null, { status: 201 });
    }
    const video = li.videos.get(`urn:li:video:${id}`);
    const part = Number(url.searchParams.get("part"));
    if (!video || Number.isNaN(part)) return apiError(404, "NOT_FOUND", "Unknown upload");
    video.parts.set(part, bytes);
    return new Response(null, { status: 200, headers: { etag: `etag-${id}-${part}` } });
  }

  if (url.host !== "api.linkedin.com") throw new Error(`Unexpected LinkedIn call: ${method} ${path}`);
  const token = headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token || !li.validTokens.has(token)) return apiError(401, "INVALID_ACCESS_TOKEN", "Invalid access token");

  if (url.pathname === "/v2/userinfo") return json(200, { ...li.member, email_verified: true });

  if (!url.pathname.startsWith("/rest/")) throw new Error(`Unexpected LinkedIn call: ${method} ${path}`);
  li.restHeaders.push(headers);
  if (headers.get("linkedin-version") !== env.linkedin!.apiVersion || headers.get("x-restli-protocol-version") !== "2.0.0") {
    return apiError(426, "VERSION_MISSING", "A valid LinkedIn-Version header is required");
  }
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
  const author = `urn:li:person:${li.member.sub}`;
  const rest = url.pathname.slice("/rest/".length);

  if (rest === "images" && url.searchParams.get("action") === "initializeUpload") {
    if (body.initializeUploadRequest?.owner !== author) return apiError(403, "ACCESS_DENIED", "Not the owner");
    const id = `IMG${++seq}`;
    li.images.set(`urn:li:image:${id}`, { owner: author });
    return json(200, { value: { uploadUrl: `https://www.linkedin.com/dms-uploads/${id}/uploaded-image/0`, uploadUrlExpiresAt: 0, image: `urn:li:image:${id}` } });
  }

  if (rest === "videos" && url.searchParams.get("action") === "initializeUpload") {
    const req = body.initializeUploadRequest;
    if (req?.owner !== author) return apiError(403, "ACCESS_DENIED", "Not the owner");
    const id = `VID${++seq}`;
    const size = Number(req.fileSizeBytes);
    li.videos.set(`urn:li:video:${id}`, { owner: author, size, parts: new Map(), finalized: false, statuses: [...li.videoStatuses] });
    const instructions = [];
    for (let first = 0, i = 0; first < size; first += PART_BYTES, i++) {
      instructions.push({ uploadUrl: `https://www.linkedin.com/dms-uploads/${id}/uploadedVideo?part=${i}`, firstByte: first, lastByte: Math.min(first + PART_BYTES, size) - 1 });
    }
    return json(200, { value: { video: `urn:li:video:${id}`, uploadToken: `upload-${id}`, uploadInstructions: instructions, uploadUrlsExpireAt: 0 } });
  }

  if (rest === "videos" && url.searchParams.get("action") === "finalizeUpload") {
    const req = body.finalizeUploadRequest;
    const video = li.videos.get(req?.video);
    if (!video) return apiError(400, "INVALID_VIDEO_ID", "This Video ID is invalid");
    const id = String(req.video).split(":").pop();
    const expected = [...video.parts.keys()].sort((a, b) => a - b).map((i) => `etag-${id}-${i}`);
    if (req.uploadToken !== `upload-${id}` || JSON.stringify(req.uploadedPartIds) !== JSON.stringify(expected)) {
      return apiError(400, "INVALID_PARTS", "Uploaded parts don't match");
    }
    video.finalized = true;
    return json(200, {});
  }

  const videoStatus = /^videos\/(.+)$/.exec(rest);
  if (videoStatus && method === "GET") {
    if (li.videoStatusForbidden) return apiError(403, "ACCESS_DENIED", "Accessing this video resource is forbidden");
    const video = li.videos.get(decodeURIComponent(videoStatus[1]!));
    if (!video) return apiError(404, "NOT_FOUND", "Could not find entity");
    const status = !video.finalized ? "WAITING_UPLOAD" : video.statuses.length > 1 ? video.statuses.shift()! : video.statuses[0]!;
    return json(200, { id: decodeURIComponent(videoStatus[1]!), status, ...(status === "PROCESSING_FAILED" ? { processingFailureReason: "Unsupported codec" } : {}) });
  }

  if (rest === "posts" && method === "POST") {
    if (body.author !== author) return apiError(403, "ACCESS_DENIED", "Not allowed to post as this author");
    if (typeof body.commentary !== "string" || body.visibility !== "PUBLIC" || body.lifecycleState !== "PUBLISHED" || body.distribution?.feedDistribution !== "MAIN_FEED") {
      return apiError(400, "MISSING_FIELD", "A required field is missing");
    }
    const mediaIds: string[] = body.content?.media ? [body.content.media.id] : (body.content?.multiImage?.images ?? []).map((i: { id: string }) => i.id);
    for (const id of mediaIds) {
      const ready = id.startsWith("urn:li:image:") ? li.images.get(id)?.bytes !== undefined : li.videos.get(id)?.finalized;
      if (!ready) return apiError(400, "MEDIA_ASSET_WAITING_UPLOAD", `Media asset ${id} is waiting upload`);
    }
    if (mediaIds.length && li.notReady > 0) {
      li.notReady--;
      return apiError(400, "MEDIA_ASSET_WAITING_UPLOAD", "Media asset is still processing");
    }
    if (body.content?.multiImage && (mediaIds.length < 2 || mediaIds.length > 20)) return apiError(400, "INVALID_VALUE_FOR_FIELD", "2 to 20 images");
    const id = createPost(body);
    return new Response(null, { status: 201, headers: { "x-restli-id": id } });
  }

  throw new Error(`Unexpected LinkedIn call: ${method} ${path}`);
}

function createPost(body: Record<string, any>) {
  const id = `urn:li:share:7000000000000${++seq}`;
  li.posts.push({ id, body });
  return id;
}
