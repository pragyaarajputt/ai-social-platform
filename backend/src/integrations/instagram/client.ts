import { PlatformApiError } from "../types.js";

// Instagram API with Instagram Login (Business Login for Instagram). Reference:
// https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
// URLs built here can contain access tokens: never log them.

export const INSIGHTS_SCOPE = "instagram_business_manage_insights";
export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish", INSIGHTS_SCOPE];

const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const SHORT_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_HOST = "https://graph.instagram.com";

export interface InstagramAppConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  graphVersion: string;
}

export interface LongLivedToken {
  accessToken: string;
  expiresInSeconds: number;
}

export interface InstagramProfile {
  id: string; // app-scoped user ID
  user_id: string; // Instagram professional account ID (used to publish)
  username?: string;
  name?: string;
  account_type?: string; // "Business" | "Media_Creator"
  profile_picture_url?: string;
}

export function buildAuthorizationUrl(app: InstagramAppConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: app.redirectUri,
    response_type: "code",
    scope: INSTAGRAM_SCOPES.join(","),
    state,
  }).toString();
  return url.toString();
}

/** Step 1: authorization code → short-lived token (about 1 hour). */
export async function exchangeCodeForShortLivedToken(
  app: InstagramAppConfig,
  code: string,
): Promise<{ accessToken: string; userId: string; permissions: string[] }> {
  const body = await request(SHORT_TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: app.appId,
      client_secret: app.appSecret,
      grant_type: "authorization_code",
      redirect_uri: app.redirectUri,
      code,
    }),
  });
  // Meta has returned both a flat object and { data: [ ... ] } for this endpoint.
  const data = firstRecord(body);
  const accessToken = data.access_token;
  if (typeof accessToken !== "string") throw unexpected("token exchange returned no access token");
  const permissions = Array.isArray(data.permissions)
    ? data.permissions.map(String)
    : typeof data.permissions === "string"
      ? data.permissions.split(",")
      : [];
  return { accessToken, userId: String(data.user_id ?? ""), permissions };
}

/** Step 2: short-lived → long-lived token (60 days). */
export async function exchangeForLongLivedToken(app: InstagramAppConfig, shortLived: string): Promise<LongLivedToken> {
  const url = new URL(`${GRAPH_HOST}/access_token`);
  url.search = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: app.appSecret,
    access_token: shortLived,
  }).toString();
  return parseLongLived(await request(url.toString()));
}

/** Refreshes a long-lived token for another 60 days. Only allowed once it is at least 24 hours old. */
export async function refreshLongLivedToken(longLived: string): Promise<LongLivedToken> {
  const url = new URL(`${GRAPH_HOST}/refresh_access_token`);
  url.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: longLived }).toString();
  return parseLongLived(await request(url.toString()));
}

export async function getProfile(app: InstagramAppConfig, accessToken: string): Promise<InstagramProfile> {
  const url = new URL(`${GRAPH_HOST}/${app.graphVersion}/me`);
  url.search = new URLSearchParams({
    fields: "id,user_id,username,name,account_type,profile_picture_url",
    access_token: accessToken,
  }).toString();
  const data = firstRecord(await request(url.toString()));
  if (data.user_id === undefined || data.id === undefined) throw unexpected("profile response has no account ID");
  return {
    id: String(data.id),
    user_id: String(data.user_id),
    username: optionalString(data.username),
    name: optionalString(data.name),
    account_type: optionalString(data.account_type),
    profile_picture_url: optionalString(data.profile_picture_url),
  };
}

// ─── Content publishing ─────────────────────────────────────────────────────
// https://developers.facebook.com/docs/instagram-platform/content-publishing

export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "PUBLISHED" | "ERROR" | "EXPIRED";

async function graphPost(app: InstagramAppConfig, path: string, accessToken: string, params: Record<string, string>) {
  // Token in the form body, not the URL, so it never shows up in URL logs.
  return request(`${GRAPH_HOST}/${app.graphVersion}/${path}`, {
    method: "POST",
    body: new URLSearchParams({ ...params, access_token: accessToken }),
  });
}

export async function graphGet(app: InstagramAppConfig, path: string, accessToken: string, params: Record<string, string>) {
  const url = new URL(`${GRAPH_HOST}/${app.graphVersion}/${path}`);
  url.search = new URLSearchParams({ ...params, access_token: accessToken }).toString();
  return request(url.toString());
}

/** Creates a media container (image, video, reel, carousel item or carousel). Returns its ID. */
export async function createContainer(
  app: InstagramAppConfig,
  igUserId: string,
  accessToken: string,
  params: Record<string, string>,
): Promise<string> {
  const body = firstRecord(await graphPost(app, `${igUserId}/media`, accessToken, params));
  if (body.id === undefined) throw unexpected("container creation returned no ID");
  return String(body.id);
}

export async function getContainerStatus(
  app: InstagramAppConfig,
  containerId: string,
  accessToken: string,
): Promise<{ statusCode: ContainerStatus; status?: string }> {
  const body = firstRecord(await graphGet(app, containerId, accessToken, { fields: "status_code,status" }));
  return { statusCode: String(body.status_code) as ContainerStatus, status: optionalString(body.status) };
}

/** Publishes a finished container. Returns the new media ID. */
export async function publishContainer(
  app: InstagramAppConfig,
  igUserId: string,
  accessToken: string,
  containerId: string,
): Promise<string> {
  const body = firstRecord(await graphPost(app, `${igUserId}/media_publish`, accessToken, { creation_id: containerId }));
  if (body.id === undefined) throw unexpected("publish returned no media ID");
  return String(body.id);
}

export async function getPermalink(app: InstagramAppConfig, mediaId: string, accessToken: string): Promise<string | undefined> {
  const body = firstRecord(await graphGet(app, mediaId, accessToken, { fields: "permalink" }));
  return optionalString(body.permalink);
}

/** The account's most recent posts, newest first. Used to recover after a crash mid-publish. */
export async function listRecentMedia(
  app: InstagramAppConfig,
  igUserId: string,
  accessToken: string,
): Promise<{ id: string; permalink?: string; timestamp?: string }[]> {
  const body = (await graphGet(app, `${igUserId}/media`, accessToken, { fields: "id,permalink,timestamp", limit: "10" })) as {
    data?: Record<string, unknown>[];
  };
  return (body.data ?? []).map((m) => ({
    id: String(m.id),
    permalink: optionalString(m.permalink),
    timestamp: optionalString(m.timestamp),
  }));
}

// ─── HTTP + errors ──────────────────────────────────────────────────────────

async function request(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new PlatformApiError("INSTAGRAM", "UNAVAILABLE", "Couldn't reach Instagram");
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toPlatformError(res.status, body);
  return body;
}

/**
 * Instagram returns errors either as Graph API errors ({ error: { code, message, ... } }) or, from
 * the OAuth endpoint, as { error_type, code, error_message }.
 */
function toPlatformError(status: number, body: unknown): PlatformApiError {
  const b = (body ?? {}) as Record<string, unknown>;
  const graph = (b.error ?? {}) as Record<string, unknown>;
  const code = Number(graph.code ?? b.code);
  const message = String(graph.message ?? b.error_message ?? `Instagram returned HTTP ${status}`);
  const details = { status, code, type: graph.type ?? b.error_type, subcode: graph.error_subcode, trace: graph.fbtrace_id };

  if (code === 190 || status === 401) return new PlatformApiError("INSTAGRAM", "INVALID_TOKEN", message, details);
  if ([4, 17, 32, 613].includes(code) || status === 429) return new PlatformApiError("INSTAGRAM", "RATE_LIMITED", message, details);
  if (code === 10 || (code >= 200 && code < 300) || status === 403) {
    return new PlatformApiError("INSTAGRAM", "PERMISSION_DENIED", message, details);
  }
  if (status >= 500) return new PlatformApiError("INSTAGRAM", "UNAVAILABLE", message, details);
  return new PlatformApiError("INSTAGRAM", "BAD_REQUEST", message, details);
}

function parseLongLived(body: unknown): LongLivedToken {
  const data = firstRecord(body);
  if (typeof data.access_token !== "string") throw unexpected("no access token in response");
  const expiresIn = Number(data.expires_in);
  return { accessToken: data.access_token, expiresInSeconds: Number.isFinite(expiresIn) ? expiresIn : 60 * 86_400 };
}

function firstRecord(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (Array.isArray(b.data) && b.data[0] && typeof b.data[0] === "object") return b.data[0] as Record<string, unknown>;
  return b;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function unexpected(what: string): PlatformApiError {
  return new PlatformApiError("INSTAGRAM", "UNAVAILABLE", `Unexpected response from Instagram: ${what}`);
}
