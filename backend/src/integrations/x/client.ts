import { optionalString } from "../meta.js";
import { PlatformApiError } from "../types.js";

// X API v2 with OAuth 2.0 user tokens (checked 2026-10-29):
// https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
// https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
// https://docs.x.com/x-api/posts/create-post
// https://docs.x.com/x-api/media/quickstart/media-upload-chunked
// X requires PKCE. Access tokens last 2 hours; offline.access adds a refresh token, and each refresh
// returns a new refresh token that replaces the old one.
// X bills API use per request (pay-per-use credits), so nothing here reads more than it needs.

/** Read the user's own profile, post as them, upload media, and get a refresh token. */
export const X_SCOPES = ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"];

export interface XAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const API = "https://api.x.com/2";
const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";

async function send(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new PlatformApiError("X", "UNAVAILABLE", "Couldn't reach X");
  }
  const text = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Append answers with an empty body.
  }
  if (!res.ok) throw toXError(res.status, body);
  return body;
}

/** A call to the v2 API as the user. JSON bodies are sent as JSON; FormData as multipart. */
function api(token: string, path: string, init: { method?: string; json?: unknown; form?: FormData } = {}) {
  return send(`${API}/${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.form,
  });
}

/**
 * v2 errors are problem documents ({ title, detail, type, status }); some carry { errors: [{ message }] }
 * instead, and the OAuth endpoints answer { error, error_description }.
 * https://docs.x.com/x-api/fundamentals/response-codes-and-errors
 */
export function toXError(status: number, body: Record<string, unknown>): PlatformApiError {
  const first = Array.isArray(body.errors) ? ((body.errors[0] ?? {}) as Record<string, unknown>) : {};
  const message = String(body.detail ?? body.error_description ?? first.message ?? body.title ?? body.error ?? `X returned HTTP ${status}`);
  const details = { status, type: body.type, title: body.title, error: body.error };
  if (status === 401) return new PlatformApiError("X", "INVALID_TOKEN", message, details);
  // 402: the app's pay-per-use credits ran out. A person has to top them up; retrying won't help.
  if (status === 402 || status === 403) return new PlatformApiError("X", "PERMISSION_DENIED", message, details);
  if (status === 429) return new PlatformApiError("X", "RATE_LIMITED", message, details);
  if (status >= 500) return new PlatformApiError("X", "UNAVAILABLE", message, details);
  return new PlatformApiError("X", "BAD_REQUEST", message, details);
}

// ─── Login ──────────────────────────────────────────────────────────────────

export function buildAuthorizationUrl(app: XAppConfig, state: string, codeChallenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    scope: X_SCOPES.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export interface XTokens {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken?: string;
  scopes: string[];
}

/** Confidential clients authenticate to the token endpoint with HTTP Basic (client ID and secret). */
async function tokenRequest(app: XAppConfig, params: Record<string, string>): Promise<XTokens> {
  const body = await send(`${API}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(app.clientId)}:${encodeURIComponent(app.clientSecret)}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  if (typeof body.access_token !== "string") throw unexpected("token request returned no access token");
  return {
    accessToken: body.access_token,
    expiresInSeconds: typeof body.expires_in === "number" ? body.expires_in : 7200,
    refreshToken: optionalString(body.refresh_token),
    scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : X_SCOPES,
  };
}

export async function exchangeCode(app: XAppConfig, code: string, codeVerifier: string) {
  try {
    return await tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: app.redirectUri, code_verifier: codeVerifier });
  } catch (err) {
    // A bad or expired code (they last 30 seconds) is the login failing, not a stored token.
    if (err instanceof PlatformApiError && err.code === "INVALID_TOKEN") throw new PlatformApiError("X", "BAD_REQUEST", err.message, err.details);
    throw err;
  }
}

export async function refreshAccessToken(app: XAppConfig, refreshToken: string) {
  try {
    return await tokenRequest(app, { grant_type: "refresh_token", refresh_token: refreshToken });
  } catch (err) {
    // invalid_grant: the refresh token was revoked, already used, or expired. Only a reconnect fixes that.
    if (err instanceof PlatformApiError && err.code === "BAD_REQUEST") throw new PlatformApiError("X", "INVALID_TOKEN", err.message, err.details);
    throw err;
  }
}

export interface XUser {
  id: string;
  username?: string;
  name?: string;
  profileImageUrl?: string;
}

/** The user the token belongs to. */
export async function getMe(token: string): Promise<XUser> {
  const body = await api(token, "users/me?user.fields=profile_image_url,username");
  const data = (body.data ?? {}) as Record<string, unknown>;
  if (typeof data.id !== "string" || !data.id) throw unexpected("no user ID");
  return { id: data.id, username: optionalString(data.username), name: optionalString(data.name), profileImageUrl: optionalString(data.profile_image_url) };
}

// ─── Media ──────────────────────────────────────────────────────────────────

const mediaId = (body: Record<string, unknown>) => {
  const id = ((body.data ?? {}) as Record<string, unknown>).id;
  if (typeof id !== "string" || !id) throw unexpected("media upload returned no media ID");
  return id;
};

/** Uploads a photo in one request. Returns the media ID to post with. */
export async function uploadImage(token: string, bytes: Uint8Array<ArrayBuffer>, mimeType: string): Promise<string> {
  const form = new FormData();
  form.append("media", new Blob([bytes], { type: mimeType }), "photo");
  form.append("media_category", "tweet_image");
  return mediaId(await api(token, "media/upload", { method: "POST", form }));
}

/** Starts a chunked (video) upload. */
export async function initializeUpload(token: string, upload: { totalBytes: number; mediaType: string }): Promise<string> {
  return mediaId(
    await api(token, "media/upload/initialize", {
      method: "POST",
      json: { media_type: upload.mediaType, total_bytes: upload.totalBytes, media_category: "tweet_video" },
    }),
  );
}

export async function appendChunk(token: string, id: string, segmentIndex: number, bytes: Uint8Array<ArrayBuffer>) {
  const form = new FormData();
  form.append("segment_index", String(segmentIndex));
  form.append("media", new Blob([bytes], { type: "application/octet-stream" }), "chunk");
  await api(token, `media/upload/${encodeURIComponent(id)}/append`, { method: "POST", form });
}

export interface ProcessingInfo {
  /** pending, in_progress, succeeded or failed. Absent: nothing to process. */
  state?: string;
  checkAfterSecs?: number;
  error?: string;
}

function processingInfo(body: Record<string, unknown>): ProcessingInfo {
  const info = ((body.data ?? {}) as Record<string, unknown>).processing_info as Record<string, unknown> | undefined;
  if (!info) return {};
  const error = (info.error ?? {}) as Record<string, unknown>;
  return {
    state: optionalString(info.state),
    checkAfterSecs: typeof info.check_after_secs === "number" ? info.check_after_secs : undefined,
    error: optionalString(error.message) ?? optionalString(error.name),
  };
}

export async function finalizeUpload(token: string, id: string): Promise<ProcessingInfo> {
  return processingInfo(await api(token, `media/upload/${encodeURIComponent(id)}/finalize`, { method: "POST" }));
}

export async function getUploadStatus(token: string, id: string): Promise<ProcessingInfo> {
  return processingInfo(await api(token, `media/upload?${new URLSearchParams({ command: "STATUS", media_id: id })}`));
}

// ─── Posts ──────────────────────────────────────────────────────────────────

/** Creates a post, optionally as a reply (the next post of a thread). Returns its ID. */
export async function createPost(token: string, post: { text: string; mediaIds?: string[]; replyTo?: string }): Promise<string> {
  const body = await api(token, "tweets", {
    method: "POST",
    json: {
      ...(post.text ? { text: post.text } : {}),
      ...(post.mediaIds?.length ? { media: { media_ids: post.mediaIds } } : {}),
      ...(post.replyTo ? { reply: { in_reply_to_tweet_id: post.replyTo } } : {}),
    },
  });
  const id = ((body.data ?? {}) as Record<string, unknown>).id;
  if (typeof id !== "string" || !id) throw unexpected("post creation returned no ID");
  return id;
}

/** Works without knowing the username, which can change. */
export const postUrl = (postId: string) => `https://x.com/i/web/status/${postId}`;

function unexpected(what: string): PlatformApiError {
  return new PlatformApiError("X", "UNAVAILABLE", `Unexpected response from X: ${what}`);
}
