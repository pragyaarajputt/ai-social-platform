import { optionalString } from "../meta.js";
import { PlatformApiError } from "../types.js";

// LinkedIn personal profiles through the versioned REST API (checked 2026-09-29):
// https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
// https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
// Both products used here (Share on LinkedIn, Sign In with LinkedIn using OpenID Connect) are
// self-serve: any LinkedIn member can connect, with no review.

/** Profile ID, name and photo (OpenID Connect), and posting as the member. */
export const LINKEDIN_SCOPES = ["openid", "profile", "w_member_social"];

export interface LinkedInAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** YYYYMM, sent as the LinkedIn-Version header. */
  apiVersion: string;
}

const API = "https://api.linkedin.com";
const OAUTH = "https://www.linkedin.com/oauth/v2";

interface LinkedInResponse {
  body: Record<string, unknown>;
  headers: Headers;
}

async function send(url: string, init: RequestInit, parse: "json" | "none" = "json"): Promise<LinkedInResponse> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new PlatformApiError("LINKEDIN", "UNAVAILABLE", "Couldn't reach LinkedIn");
  }
  const text = parse === "json" || !res.ok ? await res.text().catch(() => "") : "";
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Upload endpoints answer with an empty or non-JSON body.
  }
  if (!res.ok) throw toLinkedInError(res.status, body);
  return { body, headers: res.headers };
}

/** A call to the versioned REST API as the member. */
function rest(app: LinkedInAppConfig, token: string, path: string, init: { method?: string; json?: unknown } = {}) {
  return send(`${API}/rest/${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": app.apiVersion,
      "X-Restli-Protocol-Version": "2.0.0",
      ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
}

/**
 * LinkedIn errors look like { status, serviceErrorCode, code, message }; the OAuth endpoints use
 * { error, error_description }.
 * https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/error-handling
 */
export function toLinkedInError(status: number, body: Record<string, unknown>): PlatformApiError {
  const message = String(body.message ?? body.error_description ?? body.error ?? `LinkedIn returned HTTP ${status}`);
  const details = { status, code: body.code ?? body.error, serviceErrorCode: body.serviceErrorCode };
  if (status === 401) return new PlatformApiError("LINKEDIN", "INVALID_TOKEN", message, details);
  if (status === 403) return new PlatformApiError("LINKEDIN", "PERMISSION_DENIED", message, details);
  if (status === 429) return new PlatformApiError("LINKEDIN", "RATE_LIMITED", message, details);
  // 409 is a write conflict, which LinkedIn says to retry.
  if (status >= 500 || status === 409) return new PlatformApiError("LINKEDIN", "UNAVAILABLE", message, details);
  return new PlatformApiError("LINKEDIN", "BAD_REQUEST", message, details);
}

// ─── Login ──────────────────────────────────────────────────────────────────

export function buildAuthorizationUrl(app: LinkedInAppConfig, state: string): string {
  const url = new URL(`${OAUTH}/authorization`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    state,
    scope: LINKEDIN_SCOPES.join(" "),
  }).toString();
  return url.toString();
}

export interface LinkedInTokens {
  accessToken: string;
  expiresInSeconds: number;
  /** Only for apps LinkedIn has enabled programmatic refresh for. */
  refreshToken?: string;
  scopes: string[];
}

async function tokenRequest(params: Record<string, string>): Promise<LinkedInTokens> {
  let res: LinkedInResponse;
  try {
    res = await send(`${OAUTH}/accessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  } catch (err) {
    // A bad or expired code comes back as 400/401: that's the login failing, not a stored token.
    if (err instanceof PlatformApiError && err.code === "INVALID_TOKEN") throw new PlatformApiError("LINKEDIN", "BAD_REQUEST", err.message, err.details);
    throw err;
  }
  const b = res.body;
  if (typeof b.access_token !== "string") throw unexpected("token request returned no access token");
  return {
    accessToken: b.access_token,
    // All LinkedIn access tokens currently last 60 days.
    expiresInSeconds: typeof b.expires_in === "number" ? b.expires_in : 60 * 86_400,
    refreshToken: optionalString(b.refresh_token),
    scopes: typeof b.scope === "string" ? b.scope.split(/[ ,]+/).filter(Boolean) : LINKEDIN_SCOPES,
  };
}

export function exchangeCode(app: LinkedInAppConfig, code: string) {
  return tokenRequest({ grant_type: "authorization_code", code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri });
}

export function refreshAccessToken(app: LinkedInAppConfig, refreshToken: string) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: app.clientId, client_secret: app.clientSecret });
}

export interface LinkedInProfile {
  /** The member's ID: their Person URN is urn:li:person:{id}. */
  id: string;
  name?: string;
  pictureUrl?: string;
}

/** The member the token belongs to (OpenID Connect userinfo). */
export async function getProfile(token: string): Promise<LinkedInProfile> {
  const { body } = await send(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
  if (typeof body.sub !== "string" || !body.sub) throw unexpected("no member ID");
  const name = optionalString(body.name) ?? ([optionalString(body.given_name), optionalString(body.family_name)].filter(Boolean).join(" ") || undefined);
  return { id: body.sub, name, pictureUrl: optionalString(body.picture) };
}

export const personUrn = (memberId: string) => `urn:li:person:${memberId}`;

// ─── Media ──────────────────────────────────────────────────────────────────

/** Registers a photo; LinkedIn returns where to upload it and the image URN to post with. */
export async function initializeImageUpload(app: LinkedInAppConfig, token: string, owner: string) {
  const { body } = await rest(app, token, "images?action=initializeUpload", { method: "POST", json: { initializeUploadRequest: { owner } } });
  const value = (body.value ?? {}) as Record<string, unknown>;
  if (typeof value.uploadUrl !== "string" || typeof value.image !== "string") throw unexpected("image upload returned no upload URL");
  return { uploadUrl: value.uploadUrl, image: value.image };
}

export interface VideoUpload {
  video: string;
  uploadToken: string;
  parts: { uploadUrl: string; firstByte: number; lastByte: number }[];
}

/** Registers a video; LinkedIn splits it into parts of about 4 MB, each with its own upload URL. */
export async function initializeVideoUpload(app: LinkedInAppConfig, token: string, owner: string, fileSizeBytes: number): Promise<VideoUpload> {
  const { body } = await rest(app, token, "videos?action=initializeUpload", {
    method: "POST",
    json: { initializeUploadRequest: { owner, fileSizeBytes, uploadCaptions: false, uploadThumbnail: false } },
  });
  const value = (body.value ?? {}) as Record<string, unknown>;
  const instructions = Array.isArray(value.uploadInstructions) ? (value.uploadInstructions as Record<string, unknown>[]) : [];
  if (typeof value.video !== "string" || instructions.length === 0) throw unexpected("video upload returned no upload instructions");
  return {
    video: value.video,
    uploadToken: typeof value.uploadToken === "string" ? value.uploadToken : "",
    parts: instructions.map((p) => ({ uploadUrl: String(p.uploadUrl), firstByte: Number(p.firstByte), lastByte: Number(p.lastByte) })),
  };
}

/** Sends bytes to an upload URL from initializeUpload. Returns the ETag, which identifies a video part. */
export async function uploadBytes(uploadUrl: string, token: string, bytes: Uint8Array<ArrayBuffer>): Promise<string | undefined> {
  if (!uploadUrl.startsWith("https://")) throw unexpected("upload URL isn't https");
  const { headers } = await send(
    uploadUrl,
    { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" }, body: bytes },
    "none",
  );
  return headers.get("etag") ?? undefined;
}

export async function finalizeVideoUpload(app: LinkedInAppConfig, token: string, upload: { video: string; uploadToken: string; partIds: string[] }) {
  await rest(app, token, "videos?action=finalizeUpload", {
    method: "POST",
    json: { finalizeUploadRequest: { video: upload.video, uploadToken: upload.uploadToken, uploadedPartIds: upload.partIds } },
  });
}

/** PROCESSING, PROCESSING_FAILED, AVAILABLE or WAITING_UPLOAD. */
export async function getVideoStatus(app: LinkedInAppConfig, token: string, video: string) {
  const { body } = await rest(app, token, `videos/${encodeURIComponent(video)}`);
  return { status: optionalString(body.status), failureReason: optionalString(body.processingFailureReason) };
}

// ─── Posts ──────────────────────────────────────────────────────────────────

export type PostContent = { media: { id: string } } | { multiImage: { images: { id: string }[] } };

/** Creates a public post on the member's feed. Returns its URN (urn:li:share:… or urn:li:ugcPost:…). */
export async function createPost(app: LinkedInAppConfig, token: string, post: { author: string; text: string; content?: PostContent }) {
  const { body, headers } = await rest(app, token, "posts", {
    method: "POST",
    json: {
      author: post.author,
      commentary: toLittleText(post.text),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(post.content ? { content: post.content } : {}),
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    },
  });
  const id = headers.get("x-restli-id") ?? headers.get("x-linkedin-id") ?? optionalString(body.id);
  if (!id) throw unexpected("post creation returned no ID");
  return id;
}

export const postUrl = (postUrn: string) => `https://www.linkedin.com/feed/update/${postUrn}/`;

// ─── Text ───────────────────────────────────────────────────────────────────

// LinkedIn reads post text as "little" markup, where these characters mean something (mentions,
// hashtags, templates): https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format
// Everything is escaped so it shows exactly as typed, except hashtags, which become hashtag templates.
const RESERVED = /[|{}@[\]()<>#\\*_~]/g;
const HASHTAG = /(?<=^|\s)#([\p{L}\p{N}_]+)/gu;
const escapeLittle = (s: string) => s.replace(RESERVED, "\\$&");

export function toLittleText(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(HASHTAG)) {
    out += escapeLittle(text.slice(last, m.index)) + `{hashtag|\\#|${escapeLittle(m[1]!)}}`;
    last = m.index + m[0].length;
  }
  return out + escapeLittle(text.slice(last));
}

function unexpected(what: string): PlatformApiError {
  return new PlatformApiError("LINKEDIN", "UNAVAILABLE", `Unexpected response from LinkedIn: ${what}`);
}
