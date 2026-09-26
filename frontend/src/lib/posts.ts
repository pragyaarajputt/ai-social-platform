import { api, ApiError } from "./api";
import type { SocialAccount } from "./workspaces";

export interface MediaItem {
  id: string;
  type: "IMAGE" | "VIDEO";
  format: string;
  bytes: number;
  width: number;
  height: number;
  durationSec: number | null;
  url: string;
  thumbnailUrl: string;
  createdAt: string;
}

export type PostStatus = "DRAFT" | "SCHEDULED" | "PUBLISHING" | "PUBLISHED" | "PARTIALLY_FAILED" | "FAILED" | "CANCELLED";
export type TargetStatus = "SCHEDULED" | "QUEUED" | "PUBLISHING" | "WAITING_FOR_MEDIA" | "PUBLISHED" | "FAILED" | "CANCELLED";

/** Why a scheduled target will probably fail (computed by the server). */
export type TargetRisk = "ACCOUNT_NEEDS_RECONNECT" | "ACCESS_EXPIRES_BEFORE_POST" | null;

export interface PostTarget {
  id: string;
  format: "IMAGE" | "CAROUSEL" | "REEL";
  status: TargetStatus;
  caption: string | null;
  scheduledAt: string | null;
  permalink: string | null;
  publishedAt: string | null;
  nextAttemptAt: string | null;
  attempts: number;
  lastErrorCode: string | null;
  lastError: string | null;
  risk: TargetRisk;
  /** Numbers once published; null until the worker first collects them. */
  metrics: TargetMetrics | null;
  account: Pick<SocialAccount, "id" | "platform" | "username" | "name" | "avatarUrl" | "status"> & { tokenExpiresAt: string | null };
}

export interface TargetMetrics {
  status: "PENDING" | "OK" | "UNAVAILABLE";
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  totalInteractions: number | null;
  profileVisits: number | null;
  follows: number | null;
  avgWatchTimeMs: number | null;
  fetchedAt: string | null;
}

export interface Post {
  id: string;
  caption: string;
  status: PostStatus;
  /** Null when the post was published right away. */
  scheduledAt: string | null;
  /** An AI suggestion was applied while writing it. */
  aiAssisted: boolean;
  createdAt: string;
  updatedAt: string;
  media: MediaItem[];
  targets: PostTarget[];
}

/** The date a post belongs to on the calendar: its scheduled time, or creation time if published right away. */
export const postDate = (p: Pick<Post, "scheduledAt" | "createdAt">) => new Date(p.scheduledAt ?? p.createdAt);

// ─── Media ──────────────────────────────────────────────────────────────────

interface UploadSignature {
  uploadUrl: string;
  fields: Record<string, string | number>;
}

/**
 * Uploads a file straight from the browser to Cloudinary (it never passes through our server),
 * then registers it with the API, which reads the file's details from Cloudinary.
 */
export async function uploadMedia(workspaceId: string, file: File, onProgress: (fraction: number) => void): Promise<MediaItem> {
  const signature = await api<UploadSignature>(`/workspaces/${workspaceId}/media/upload-signature`, { method: "POST" });

  const form = new FormData();
  for (const [key, value] of Object.entries(signature.fields)) form.append(key, String(value));
  form.append("file", file);

  const uploaded = await new Promise<{ public_id: string; resource_type: "image" | "video" }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", signature.uploadUrl);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: { public_id?: string; resource_type?: string; error?: { message?: string } } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // handled below
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.public_id) {
        resolve({ public_id: body.public_id, resource_type: body.resource_type === "video" ? "video" : "image" });
      } else {
        reject(new ApiError(xhr.status, "UPLOAD_FAILED", body.error?.message ?? "Upload failed. Try again."));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "NETWORK_ERROR", "Upload failed. Check your connection."));
    xhr.send(form);
  });

  const { media } = await api<{ media: MediaItem }>(`/workspaces/${workspaceId}/media`, {
    method: "POST",
    body: { publicId: uploaded.public_id, resourceType: uploaded.resource_type },
  });
  return media;
}

// ─── Posts ──────────────────────────────────────────────────────────────────

export interface CreatePostInput {
  caption: string;
  mediaIds: string[];
  targets: { socialAccountId: string; captionOverride?: string }[];
  /** ISO time; omit to publish now. */
  scheduledAt?: string;
  aiAssisted?: boolean;
}

export async function createPost(workspaceId: string, input: CreatePostInput): Promise<Post> {
  return (await api<{ post: Post }>(`/workspaces/${workspaceId}/posts`, { method: "POST", body: input })).post;
}

/** Edits a scheduled post. `scheduledAt: null` publishes it now. */
export async function updatePost(
  workspaceId: string,
  postId: string,
  input: Partial<Omit<CreatePostInput, "scheduledAt">> & { scheduledAt?: string | null },
): Promise<Post> {
  return (await api<{ post: Post }>(`/workspaces/${workspaceId}/posts/${postId}`, { method: "PATCH", body: input })).post;
}

export async function cancelPost(workspaceId: string, postId: string): Promise<Post> {
  return (await api<{ post: Post }>(`/workspaces/${workspaceId}/posts/${postId}/cancel`, { method: "POST" })).post;
}

export function deletePost(workspaceId: string, postId: string): Promise<void> {
  return api(`/workspaces/${workspaceId}/posts/${postId}`, { method: "DELETE" });
}

export async function listPosts(workspaceId: string, query: { from?: Date; to?: Date; status?: PostStatus[] } = {}): Promise<Post[]> {
  const params = new URLSearchParams();
  if (query.from) params.set("from", query.from.toISOString());
  if (query.to) params.set("to", query.to.toISOString());
  if (query.status?.length) params.set("status", query.status.join(","));
  const qs = params.toString();
  return (await api<{ posts: Post[] }>(`/workspaces/${workspaceId}/posts${qs ? `?${qs}` : ""}`)).posts;
}

export interface AtRiskItem {
  postId: string;
  targetId: string;
  caption: string;
  scheduledAt: string;
  account: { id: string; username: string | null };
  risk: Exclude<TargetRisk, null>;
}

export async function listAtRisk(workspaceId: string): Promise<AtRiskItem[]> {
  return (await api<{ atRisk: AtRiskItem[] }>(`/workspaces/${workspaceId}/posts/at-risk`)).atRisk;
}

export const riskMessage = (risk: Exclude<TargetRisk, null>, username: string | null) =>
  risk === "ACCOUNT_NEEDS_RECONNECT"
    ? `@${username} needs to be reconnected, or this post will fail.`
    : `@${username}'s access expires before the post time. Reconnect it to renew access.`;

export async function getPost(workspaceId: string, postId: string): Promise<Post> {
  return (await api<{ post: Post }>(`/workspaces/${workspaceId}/posts/${postId}`)).post;
}

export async function retryTarget(workspaceId: string, postId: string, targetId: string): Promise<Post> {
  return (await api<{ post: Post }>(`/workspaces/${workspaceId}/posts/${postId}/targets/${targetId}/retry`, { method: "POST" })).post;
}

/** Still moving through the queue: worth polling for updates. */
export const isInProgress = (s: TargetStatus) => s === "QUEUED" || s === "PUBLISHING" || s === "WAITING_FOR_MEDIA";
