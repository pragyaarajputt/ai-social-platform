import { prisma } from "../config/database.js";
import type { MediaAsset } from "../generated/prisma/client.js";
import * as cloudinary from "../storage/cloudinary.js";
import { AppError } from "../utils/AppError.js";

// What we accept from users. Images are converted to JPEG on delivery; videos are sent as uploaded,
// so only formats Instagram accepts directly are allowed.
const IMAGE_FORMATS = ["jpg", "jpeg", "png", "webp", "heic", "heif"];
const VIDEO_FORMATS = ["mp4", "mov"];

export function toPublicMedia(m: MediaAsset) {
  return {
    id: m.id,
    type: m.type,
    format: m.format,
    bytes: m.bytes,
    width: m.width,
    height: m.height,
    durationSec: m.durationSec,
    url: m.secureUrl,
    thumbnailUrl: cloudinary.thumbnailUrl(m),
    createdAt: m.createdAt,
  };
}

export function createUploadSignature(workspaceId: string) {
  return cloudinary.createUploadSignature(workspaceId);
}

/** Called after the browser finished uploading: record the file, using Cloudinary's metadata. */
export async function registerMedia(params: {
  workspaceId: string;
  userId: string;
  publicId: string;
  resourceType: "image" | "video";
}) {
  // Only files uploaded with a signature we issued for this workspace.
  if (!params.publicId.startsWith(cloudinary.workspacePrefix(params.workspaceId))) {
    throw new AppError(400, "INVALID_UPLOAD", "This file wasn't uploaded to this workspace");
  }
  const resource = await cloudinary.getResource(params.resourceType, params.publicId);
  if (!resource) throw new AppError(400, "INVALID_UPLOAD", "Upload not found. Try uploading again.");

  const type = resource.resourceType === "video" ? "VIDEO" : "IMAGE";
  const allowed = type === "VIDEO" ? VIDEO_FORMATS : IMAGE_FORMATS;
  if (!allowed.includes(resource.format)) {
    throw new AppError(
      400,
      "UNSUPPORTED_FORMAT",
      type === "VIDEO"
        ? `.${resource.format} videos aren't supported yet. Upload an MP4 or MOV file.`
        : `.${resource.format} images aren't supported. Upload JPEG, PNG, WebP or HEIC.`,
    );
  }

  const data = {
    type,
    format: resource.format,
    bytes: resource.bytes,
    width: resource.width,
    height: resource.height,
    durationSec: resource.durationSec ?? null,
    secureUrl: resource.secureUrl,
  } as const;
  const asset = await prisma.mediaAsset.upsert({
    where: { workspaceId_publicId: { workspaceId: params.workspaceId, publicId: resource.publicId } },
    create: { ...data, workspaceId: params.workspaceId, publicId: resource.publicId, uploadedById: params.userId },
    update: { ...data, deletedAt: null },
  });
  return toPublicMedia(asset);
}

export async function listMedia(workspaceId: string) {
  const assets = await prisma.mediaAsset.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return assets.map(toPublicMedia);
}

/** Soft delete: hidden from the library, but posts that already used it keep working. */
export async function deleteMedia(workspaceId: string, mediaId: string) {
  const { count } = await prisma.mediaAsset.updateMany({
    where: { id: mediaId, workspaceId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (count === 0) throw new AppError(404, "MEDIA_NOT_FOUND", "Media not found");
}
