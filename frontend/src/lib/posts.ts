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

export type PostStatus = "DRAFT" | "PUBLISHING" | "PUBLISHED" | "PARTIALLY_FAILED" | "FAILED";
export type TargetStatus = "QUEUED" | "PUBLISHING" | "WAITING_FOR_MEDIA" | "PUBLISHED" | "FAILED" | "CANCELLED";

export interface PostTarget {
  id: string;
  format: "IMAGE" | "CAROUSEL" | "REEL";
  status: TargetStatus;
  caption: string | null;
  permalink: string | null;
  publishedAt: string | null;
  nextAttemptAt: string | null;
  attempts: number;
  lastErrorCode: string | null;
  lastError: string | null;
  account: Pick<SocialAccount, "id" | "platform" | "username" | "name" | "avatarUrl" | "status">;
}

export interface Post {
  id: string;
  caption: string;
  status: PostStatus;
  createdAt: string;
  updatedAt: string;
  media: Pick<MediaItem, "id" | "type" | "width" | "height" | "thumbnailUrl">[];
  targets: PostTarget[];
}

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
}

export async function createPost(workspaceId: string, input: CreatePostInput): Promise<Post> {
  return (await api<{ post: Post }>(`/workspaces/${workspaceId}/posts`, { method: "POST", body: input })).post;
}

export async function listPosts(workspaceId: string): Promise<Post[]> {
  return (await api<{ posts: Post[] }>(`/workspaces/${workspaceId}/posts`)).posts;
}

export async function getPost(workspaceId: string, postId: string): Promise<Post> {
  return (await api<{ post: Post }>(`/workspaces/${workspaceId}/posts/${postId}`)).post;
}

export async function retryTarget(workspaceId: string, postId: string, targetId: string): Promise<Post> {
  return (await api<{ post: Post }>(`/workspaces/${workspaceId}/posts/${postId}/targets/${targetId}/retry`, { method: "POST" })).post;
}

/** Still moving through the queue: worth polling for updates. */
export const isInProgress = (s: TargetStatus) => s === "QUEUED" || s === "PUBLISHING" || s === "WAITING_FOR_MEDIA";
