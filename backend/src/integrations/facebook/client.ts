import { firstRecord, metaRequest, optionalString } from "../meta.js";
import { PlatformApiError } from "../types.js";

// Facebook Pages through the Graph API, with Facebook Login for Business (checked 2026-09-26):
// https://developers.facebook.com/docs/facebook-login/facebook-login-for-business
// https://developers.facebook.com/docs/pages-api/posts
// https://developers.facebook.com/docs/video-api/guides/reels-publishing
// URLs built here can contain access tokens: never log them.

export const FACEBOOK_SCOPES = ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "read_insights", "business_management"];
export const INSIGHTS_SCOPE = "read_insights";

export interface FacebookAppConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  configId?: string;
  graphVersion: string;
}

const GRAPH_HOST = "https://graph.facebook.com";
const VIDEO_HOST = "https://graph-video.facebook.com";
const RUPLOAD_HOST = "https://rupload.facebook.com";

const request = (url: string, init?: RequestInit) => metaRequest("FACEBOOK", url, init);
const graphUrl = (app: FacebookAppConfig, path: string, params: Record<string, string>, host = GRAPH_HOST) => {
  const url = new URL(`${host}/${app.graphVersion}/${path}`);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
};

export async function graphGet(app: FacebookAppConfig, path: string, accessToken: string, params: Record<string, string> = {}) {
  return request(graphUrl(app, path, { ...params, access_token: accessToken }));
}

/** Token in the form body, not the URL, so it never shows up in URL logs. */
export async function graphPost(app: FacebookAppConfig, path: string, accessToken: string, params: Record<string, string>, host = GRAPH_HOST) {
  return request(`${host}/${app.graphVersion}/${path}`, { method: "POST", body: new URLSearchParams({ ...params, access_token: accessToken }) });
}

// ─── Login ──────────────────────────────────────────────────────────────────

/** The login dialog. With a login configuration, it decides the permissions; otherwise we ask for FACEBOOK_SCOPES. */
export function buildAuthorizationUrl(app: FacebookAppConfig, state: string): string {
  const url = new URL(`https://www.facebook.com/${app.graphVersion}/dialog/oauth`);
  url.search = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: app.redirectUri,
    response_type: "code",
    state,
    ...(app.configId ? { config_id: app.configId } : { scope: FACEBOOK_SCOPES.join(",") }),
  }).toString();
  return url.toString();
}

/** Code → short-lived user token → long-lived (about 60 days) user token. */
export async function exchangeCode(app: FacebookAppConfig, code: string): Promise<string> {
  const short = firstRecord(
    await request(graphUrl(app, "oauth/access_token", { client_id: app.appId, client_secret: app.appSecret, redirect_uri: app.redirectUri, code })),
  );
  if (typeof short.access_token !== "string") throw unexpected("code exchange returned no access token");
  const long = firstRecord(
    await request(
      graphUrl(app, "oauth/access_token", { grant_type: "fb_exchange_token", client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: short.access_token }),
    ),
  );
  if (typeof long.access_token !== "string") throw unexpected("long-lived exchange returned no access token");
  return long.access_token;
}

/** The app-scoped ID of the Facebook user who logged in (what Meta's deauthorize callback sends). */
export async function getUserId(app: FacebookAppConfig, userToken: string): Promise<string> {
  const me = firstRecord(await graphGet(app, "me", userToken, { fields: "id" }));
  if (me.id === undefined) throw unexpected("no user ID");
  return String(me.id);
}

export async function getGrantedPermissions(app: FacebookAppConfig, userToken: string): Promise<string[]> {
  const body = (await graphGet(app, "me/permissions", userToken)) as { data?: { permission?: string; status?: string }[] };
  return (body.data ?? []).filter((p) => p.status === "granted" && p.permission).map((p) => p.permission!);
}

export interface FacebookPage {
  id: string;
  name?: string;
  username?: string;
  accessToken: string;
  tasks: string[];
  pictureUrl?: string;
}

/**
 * The Pages the user granted, each with a Page access token. Obtained with a long-lived user token,
 * Page tokens don't expire; they stop working if the user removes the app, loses their role on the
 * Page, or changes their password.
 */
export async function listPages(app: FacebookAppConfig, userToken: string): Promise<FacebookPage[]> {
  const pages: FacebookPage[] = [];
  let url: string | undefined = graphUrl(app, "me/accounts", {
    fields: "id,name,username,access_token,tasks,picture{url}",
    limit: "100",
    access_token: userToken,
  });
  // A handful of result pages at most; nobody grants hundreds of Pages to one login.
  for (let i = 0; url && i < 5; i++) {
    const body = (await request(url)) as { data?: Record<string, unknown>[]; paging?: { next?: string } };
    for (const p of body.data ?? []) {
      if (typeof p.access_token !== "string" || p.id === undefined) continue;
      pages.push({
        id: String(p.id),
        name: optionalString(p.name),
        username: optionalString(p.username),
        accessToken: p.access_token,
        tasks: Array.isArray(p.tasks) ? p.tasks.map(String) : [],
        pictureUrl: optionalString((p.picture as { data?: { url?: unknown } } | undefined)?.data?.url),
      });
    }
    url = body.paging?.next;
  }
  return pages;
}

// ─── Publishing ─────────────────────────────────────────────────────────────

export async function createFeedPost(app: FacebookAppConfig, pageId: string, token: string, params: Record<string, string>): Promise<string> {
  const body = firstRecord(await graphPost(app, `${pageId}/feed`, token, params));
  if (body.id === undefined) throw unexpected("post creation returned no ID");
  return String(body.id);
}

/** A photo. Published: returns the post ID. Unpublished (for a multi-photo post): returns the photo ID. */
export async function uploadPhoto(app: FacebookAppConfig, pageId: string, token: string, params: { url: string; caption?: string; published: boolean }) {
  const body = firstRecord(
    await graphPost(app, `${pageId}/photos`, token, {
      url: params.url,
      published: String(params.published),
      ...(params.caption ? { caption: params.caption } : {}),
    }),
  );
  if (body.id === undefined) throw unexpected("photo upload returned no ID");
  return { photoId: String(body.id), postId: optionalString(body.post_id) };
}

/** A regular video post from a hosted file. Facebook downloads and processes it asynchronously. */
export async function uploadVideo(app: FacebookAppConfig, pageId: string, token: string, params: { fileUrl: string; description: string }) {
  const body = firstRecord(await graphPost(app, `${pageId}/videos`, token, { file_url: params.fileUrl, description: params.description }, VIDEO_HOST));
  if (body.id === undefined) throw unexpected("video upload returned no ID");
  return String(body.id);
}

export async function startReel(app: FacebookAppConfig, pageId: string, token: string): Promise<string> {
  const body = firstRecord(await graphPost(app, `${pageId}/video_reels`, token, { upload_phase: "start" }));
  if (body.video_id === undefined) throw unexpected("reel start returned no video ID");
  return String(body.video_id);
}

/** Facebook fetches the Reel from a hosted URL (no need to send the bytes ourselves). */
export async function uploadReelFromUrl(app: FacebookAppConfig, videoId: string, token: string, fileUrl: string): Promise<void> {
  const body = firstRecord(
    await request(`${RUPLOAD_HOST}/video-upload/${app.graphVersion}/${videoId}`, {
      method: "POST",
      headers: { Authorization: `OAuth ${token}`, file_url: fileUrl },
    }),
  );
  if (body.success !== true) throw unexpected("reel upload didn't succeed");
}

export async function finishReel(app: FacebookAppConfig, pageId: string, token: string, videoId: string, description: string): Promise<void> {
  const body = firstRecord(
    await graphPost(app, `${pageId}/video_reels`, token, { upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description }),
  );
  if (body.success !== true) throw unexpected("reel publish didn't succeed");
}

export interface VideoStatus {
  /** e.g. "upload_complete", "processing", "ready", "error" */
  videoStatus?: string;
  /** Reels: "not_started", "in_progress", "complete", "error" */
  publishingStatus?: string;
  errorMessage?: string;
  postId?: string;
  permalink?: string;
}

export async function getVideoStatus(app: FacebookAppConfig, videoId: string, token: string): Promise<VideoStatus> {
  const body = firstRecord(await graphGet(app, videoId, token, { fields: "status,permalink_url,post_id" }));
  const status = (body.status ?? {}) as Record<string, Record<string, unknown> | string | undefined>;
  const phase = (name: string) => (typeof status[name] === "object" ? (status[name] as Record<string, unknown>) : undefined);
  const errors = [phase("processing_phase"), phase("publishing_phase"), phase("uploading_phase")]
    .map((p) => (p?.errors as { message?: string }[] | undefined)?.[0]?.message ?? (p?.error as { message?: string } | undefined)?.message)
    .find(Boolean);
  return {
    videoStatus: optionalString(status.video_status),
    publishingStatus: optionalString(phase("publishing_phase")?.status),
    errorMessage: errors,
    postId: optionalString(body.post_id),
    permalink: absolutePermalink(optionalString(body.permalink_url)),
  };
}

export async function getPostPermalink(app: FacebookAppConfig, postId: string, token: string): Promise<string | undefined> {
  const body = firstRecord(await graphGet(app, postId, token, { fields: "permalink_url" }));
  return absolutePermalink(optionalString(body.permalink_url));
}

/** The Page's latest posts, newest first. Used to recover after a crash mid-publish. */
export async function listRecentPosts(app: FacebookAppConfig, pageId: string, token: string) {
  const body = (await graphGet(app, `${pageId}/published_posts`, token, { fields: "id,message,created_time,permalink_url", limit: "10" })) as {
    data?: Record<string, unknown>[];
  };
  return (body.data ?? []).map((p) => ({
    id: String(p.id),
    message: optionalString(p.message) ?? "",
    createdTime: optionalString(p.created_time),
    permalink: absolutePermalink(optionalString(p.permalink_url)),
  }));
}

/** Video permalinks come back relative ("/reel/123"). */
function absolutePermalink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith("/") ? `https://www.facebook.com${url}` : url;
}

function unexpected(what: string): PlatformApiError {
  return new PlatformApiError("FACEBOOK", "UNAVAILABLE", `Unexpected response from Facebook: ${what}`);
}
