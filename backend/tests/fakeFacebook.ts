// A fake Facebook Graph API (graph.facebook.com, graph-video.facebook.com, rupload.facebook.com),
// used through the fetch mock in support.ts. Tokens: the login code is "fb-good-code"; the long-lived
// user token is "fb-user-long"; every Page token is "fb-page-token".
import { env } from "../src/config/env.js";

export const FB_PAGE = "1000000000000001";
export const FB_USER = "fb-app-scoped-user-1";
export const PAGE_TOKEN = "fb-page-token";

interface FakeVideo {
  kind: "video" | "reel";
  pageId: string;
  description?: string;
  fileUrl?: string;
  uploaded: boolean;
  finished: boolean;
  /** video_status returned by successive status checks; the last one repeats. */
  statuses: string[];
  postId?: string;
}

export interface FakeFacebook {
  pages: { id: string; name: string; username?: string; access_token: string; tasks: string[] }[];
  permissions: string[];
  posts: { id: string; pageId: string; message: string; created_time: string; attached?: string[]; photo?: string }[];
  photos: Map<string, { url: string; published: boolean; caption?: string }>;
  videos: Map<string, FakeVideo>;
  /** video_status sequence for new videos and Reels (default: ready at once). */
  videoStatuses: string[];
  /** Answer the next calls whose "METHOD path" contains `match` with these responses. When `thenCreate` is set, the post is created first (Facebook failing after doing the work). */
  failures: { match: string; status: number; body: unknown; thenCreate?: boolean }[];
  /** "METHOD host/path" of every call. */
  calls: string[];
  /** Headers sent to the Reel upload service. */
  ruploadHeaders: Record<string, string>[];
  insights: { post: Record<string, unknown>; page: Record<string, number>; followers: number; shares: number; comments: number };
}

export let fb: FakeFacebook;

export function resetFacebook() {
  fb = {
    pages: [
      { id: FB_PAGE, name: "Pune Cafe", username: "punecafe", access_token: PAGE_TOKEN, tasks: ["ANALYZE", "ADVERTISE", "MODERATE", "CREATE_CONTENT", "MANAGE"] },
    ],
    permissions: ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "read_insights", "business_management", "public_profile"],
    posts: [],
    photos: new Map(),
    videos: new Map(),
    videoStatuses: ["ready"],
    failures: [],
    calls: [],
    ruploadHeaders: [],
    insights: {
      post: { post_media_view: 3400, post_total_media_view_unique: 2100, post_reactions_by_type_total: { like: 80, love: 12, haha: 3 } },
      page: { page_media_view: 700, page_total_media_view_unique: 450 },
      followers: 3100,
      shares: 9,
      comments: 14,
    },
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const graphError = (message: string, code: number, status = 400) => json(status, { error: { message, type: "OAuthException", code, fbtrace_id: "trace" } });

let seq = 0;
const nextId = () => String(900000 + ++seq);

/** Handles a request if it's for Facebook; returns null otherwise. */
export function handleFacebook(url: URL, init?: RequestInit): Response | null {
  if (!["graph.facebook.com", "graph-video.facebook.com", "rupload.facebook.com"].includes(url.host)) return null;
  const method = init?.method ?? "GET";
  const form = init?.body ? new URLSearchParams(String(init.body)) : url.searchParams;
  const v = env.facebook!.graphVersion;
  const path = url.pathname.replace(`/video-upload/${v}/`, "video-upload/").replace(`/${v}/`, "");
  fb.calls.push(`${method} ${url.host === "graph.facebook.com" ? "" : `${url.host}/`}${path}`);

  const failure = fb.failures.findIndex((f) => `${method} ${path}`.includes(f.match));
  if (failure >= 0) {
    const f = fb.failures.splice(failure, 1)[0]!;
    if (f.thenCreate) {
      // Do the work, then report a failure anyway (the call is only logged once).
      handleFacebook(url, init);
      fb.calls.pop();
    }
    return json(f.status, f.body);
  }

  // ─── Login ──
  if (path === "oauth/access_token") {
    if (form.get("client_secret") !== env.facebook!.appSecret) return graphError("Invalid client_secret", 1);
    if (form.get("grant_type") === "fb_exchange_token") {
      return form.get("fb_exchange_token") === "fb-user-short" ? json(200, { access_token: "fb-user-long", token_type: "bearer", expires_in: 5_184_000 }) : graphError("Bad token", 190);
    }
    if (form.get("redirect_uri") !== env.facebook!.redirectUri) return graphError("redirect_uri mismatch", 100);
    return form.get("code") === "fb-good-code" ? json(200, { access_token: "fb-user-short", token_type: "bearer" }) : graphError("Invalid verification code format.", 100);
  }
  if (path.startsWith("me")) {
    if (form.get("access_token") !== "fb-user-long") return graphError("Invalid OAuth access token", 190);
    if (path === "me") return json(200, { id: FB_USER });
    if (path === "me/permissions") return json(200, { data: fb.permissions.map((permission) => ({ permission, status: "granted" })) });
    if (path === "me/accounts") {
      return json(200, { data: fb.pages.map((p) => ({ ...p, picture: { data: { url: `https://fb.example/${p.id}.jpg` } } })), paging: {} });
    }
  }

  // ─── Everything else needs a Page token ──
  const token = url.host === "rupload.facebook.com" ? (init?.headers as Record<string, string>)?.Authorization?.replace("OAuth ", "") : form.get("access_token");
  if (token !== PAGE_TOKEN) return graphError("Error validating access token: The session has been invalidated.", 190);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "+0000");

  if (url.host === "rupload.facebook.com") {
    const video = fb.videos.get(path.split("/").pop()!);
    if (!video) return json(400, { debug_info: { message: "unknown video" } });
    fb.ruploadHeaders.push({ ...(init?.headers as Record<string, string>) });
    video.uploaded = true;
    video.fileUrl = (init?.headers as Record<string, string>).file_url;
    return json(200, { success: true });
  }

  const [first, second] = path.split("/");
  if (method === "POST") {
    if (second === "feed") {
      const attached = [...form.keys()].filter((k) => k.startsWith("attached_media")).map((k) => JSON.parse(form.get(k)!).media_fbid as string);
      if (attached.some((id) => !fb.photos.has(id) || fb.photos.get(id)!.published)) return graphError("Invalid attached media", 100);
      const id = `${first}_${nextId()}`;
      fb.posts.unshift({ id, pageId: first!, message: form.get("message") ?? "", created_time: now, attached });
      return json(200, { id });
    }
    if (second === "photos") {
      const id = nextId();
      const published = form.get("published") !== "false";
      fb.photos.set(id, { url: form.get("url")!, published, caption: form.get("caption") ?? undefined });
      if (!published) return json(200, { id });
      const postId = `${first}_${nextId()}`;
      fb.posts.unshift({ id: postId, pageId: first!, message: form.get("caption") ?? "", created_time: now, photo: id });
      return json(200, { id, post_id: postId });
    }
    if (second === "videos" && url.host === "graph-video.facebook.com") {
      const id = nextId();
      fb.videos.set(id, { kind: "video", pageId: first!, description: form.get("description") ?? "", fileUrl: form.get("file_url")!, uploaded: true, finished: true, statuses: [...fb.videoStatuses] });
      return json(200, { id });
    }
    if (second === "video_reels") {
      if (form.get("upload_phase") === "start") {
        const id = nextId();
        fb.videos.set(id, { kind: "reel", pageId: first!, uploaded: false, finished: false, statuses: [...fb.videoStatuses] });
        return json(200, { video_id: id, upload_url: `https://rupload.facebook.com/video-upload/${v}/${id}` });
      }
      const video = fb.videos.get(form.get("video_id")!);
      if (!video || !video.uploaded) return graphError("Video not uploaded", 100);
      if (video.finished) return graphError("Video already published", 100);
      video.finished = true;
      video.description = form.get("description") ?? "";
      return json(200, { success: true });
    }
  }

  if (method === "GET") {
    const video = fb.videos.get(first!);
    if (video && !second) {
      const videoStatus = video.statuses.length > 1 ? video.statuses.shift()! : video.statuses[0]!;
      const publishing = video.kind === "reel" ? (!video.finished ? "not_started" : videoStatus === "ready" ? "complete" : "in_progress") : undefined;
      if (videoStatus === "ready" && (video.kind === "video" || publishing === "complete") && !video.postId) {
        video.postId = `${video.pageId}_${nextId()}`;
        fb.posts.unshift({ id: video.postId, pageId: video.pageId, message: video.description ?? "", created_time: now });
      }
      return json(200, {
        id: first,
        status: {
          video_status: videoStatus,
          ...(publishing && { publishing_phase: { status: publishing } }),
          ...(videoStatus === "error" && { processing_phase: { status: "error", errors: [{ code: 1, message: "Unsupported video format" }] } }),
        },
        post_id: video.postId,
        permalink_url: video.postId ? `/${video.kind === "reel" ? "reel" : "watch"}/${first}` : undefined,
      });
    }
    if (second === "published_posts") return json(200, { data: fb.posts.filter((p) => p.pageId === first).map((p) => ({ ...p, permalink_url: `https://www.facebook.com/${p.id}` })) });
    if (second === "insights" && first === FB_PAGE) {
      return json(200, { data: form.get("metric")!.split(",").map((name) => ({ name, period: "day", values: [{ value: fb.insights.page[name] ?? 0, end_time: now }] })) });
    }
    if (second === "insights") {
      if (!fb.posts.some((p) => p.id === first)) return graphError("Unsupported get request. Object does not exist", 100);
      return json(200, { data: form.get("metric")!.split(",").map((name) => ({ name, period: "lifetime", values: [{ value: fb.insights.post[name] ?? 0 }] })) });
    }
    if (first === FB_PAGE && !second) {
      return json(200, { id: FB_PAGE, name: fb.pages[0]!.name, username: fb.pages[0]!.username, followers_count: fb.insights.followers, picture: { data: { url: "https://fb.example/page.jpg" } } });
    }
    const post = fb.posts.find((p) => p.id === first);
    if (post && !second) {
      return json(200, {
        id: post.id,
        permalink_url: `https://www.facebook.com/${post.id}`,
        shares: { count: fb.insights.shares },
        comments: { data: [], summary: { total_count: fb.insights.comments } },
        reactions: { data: [], summary: { total_count: 1 } },
      });
    }
  }
  throw new Error(`Unexpected Facebook call: ${method} ${url.host}/${path}`);
}
