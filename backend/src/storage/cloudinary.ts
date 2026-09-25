import { createHash, randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

// Cloudinary over its REST API with plain fetch (no SDK): signing is one SHA-1 hash, and tests can
// fake Cloudinary the same way they fake Instagram.
// Signing: https://cloudinary.com/documentation/authentication_signatures

export type CloudinaryResourceType = "image" | "video";

export interface CloudinaryResource {
  publicId: string;
  resourceType: CloudinaryResourceType;
  format: string;
  bytes: number;
  width: number;
  height: number;
  durationSec?: number;
  secureUrl: string;
}

function config() {
  if (!env.cloudinary) throw new AppError(501, "NOT_CONFIGURED", "Media uploads aren't set up on this server yet");
  return env.cloudinary;
}

export const isCloudinaryConfigured = () => env.cloudinary !== undefined;

/** Where a workspace's uploads live. The server chooses every public_id, so uploads can't land elsewhere. */
export const workspacePrefix = (workspaceId: string) => `${config().folder}/${workspaceId}/`;

/** SHA-1 of the sorted "key=value" pairs joined by "&", followed by the API secret. */
export function signParams(params: Record<string, string | number>, apiSecret: string): string {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(toSign + apiSecret).digest("hex");
}

/**
 * Parameters for one direct browser upload. The browser POSTs the file plus exactly these fields
 * to `uploadUrl`; changing any signed field (public_id, timestamp) invalidates the signature.
 */
export function createUploadSignature(workspaceId: string) {
  const c = config();
  const params = { public_id: `${workspacePrefix(workspaceId)}${randomUUID()}`, timestamp: Math.floor(Date.now() / 1000) };
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${c.cloudName}/auto/upload`,
    fields: { ...params, api_key: c.apiKey, signature: signParams(params, c.apiSecret) },
  };
}

/** Looks up an uploaded file with our own credentials, so its metadata can't be faked by the browser. */
export async function getResource(resourceType: CloudinaryResourceType, publicId: string): Promise<CloudinaryResource | null> {
  const c = config();
  const path = publicId.split("/").map(encodeURIComponent).join("/");
  let res: Response;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${c.cloudName}/resources/${resourceType}/upload/${path}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${c.apiKey}:${c.apiSecret}`).toString("base64")}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError(502, "STORAGE_UNAVAILABLE", "Couldn't reach the media storage service");
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new AppError(502, "STORAGE_UNAVAILABLE", `Media storage returned HTTP ${res.status}`);

  const b = (await res.json()) as Record<string, unknown>;
  return {
    publicId: String(b.public_id),
    resourceType,
    format: String(b.format ?? "").toLowerCase(),
    bytes: Number(b.bytes ?? 0),
    width: Number(b.width ?? 0),
    height: Number(b.height ?? 0),
    durationSec: typeof b.duration === "number" ? b.duration : undefined,
    secureUrl: String(b.secure_url),
  };
}

type StoredAsset = { type: "IMAGE" | "VIDEO"; secureUrl: string };

/**
 * Inserts a transformation into a stored Cloudinary URL and changes its extension, e.g.
 * .../image/upload/v1/a/b.png → .../image/upload/c_fill,w_320/v1/a/b.jpg. Built from the URL
 * Cloudinary gave us, so it keeps working even if the server's Cloudinary settings change.
 */
function transformed(secureUrl: string, kind: "image" | "video", transformation: string, extension: string): string {
  const marker = `/${kind}/upload/`;
  if (!secureUrl.includes(marker)) return secureUrl;
  const withTransform = secureUrl.replace(marker, `${marker}${transformation}/`);
  return withTransform.replace(/\.[a-z0-9]+$/i, `.${extension}`);
}

/**
 * The URL a platform downloads from. Images are delivered as JPEG (Instagram accepts only JPEG),
 * at most 1440 px wide, with automatic quality to stay under size limits. Videos are delivered as uploaded.
 */
export function deliveryUrl(asset: StoredAsset): string {
  if (asset.type === "VIDEO") return asset.secureUrl;
  return transformed(asset.secureUrl, "image", "c_limit,w_1440,q_auto", "jpg");
}

/**
 * What the AI sees: the whole image (for videos, the first frame) as a JPEG of at most 1024 px.
 * Big enough to understand the picture; smaller images cost fewer tokens.
 */
export function aiPreviewUrl(asset: StoredAsset): string {
  return asset.type === "VIDEO"
    ? transformed(asset.secureUrl, "video", "c_limit,w_1024,h_1024,so_0", "jpg")
    : transformed(asset.secureUrl, "image", "c_limit,w_1024,h_1024,q_auto", "jpg");
}

/** A small square preview for the UI (for videos, the first frame). */
export function thumbnailUrl(asset: StoredAsset): string {
  return asset.type === "VIDEO"
    ? transformed(asset.secureUrl, "video", "c_fill,w_320,h_320,so_0", "jpg")
    : transformed(asset.secureUrl, "image", "c_fill,w_320,h_320,q_auto", "jpg");
}
