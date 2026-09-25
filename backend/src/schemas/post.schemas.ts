import { z } from "zod";

const uuid = z.uuid("Invalid ID");

const targets = z
  .array(
    z.object({
      socialAccountId: uuid,
      captionOverride: z.string().max(10_000).optional(),
    }),
  )
  .min(1, "Choose at least one account")
  .max(20);

/** An ISO 8601 date-time with an offset, e.g. 2026-10-01T09:00:00.000Z. Business rules live in post.service. */
const scheduledAt = z.iso.datetime({ offset: true, message: "Invalid date and time" }).transform((v) => new Date(v));

export const createPostSchema = z.object({
  caption: z.string().max(10_000).default(""),
  mediaIds: z.array(uuid).max(10, "At most 10 media per post").default([]),
  targets,
  /** Omit to publish now. */
  scheduledAt: scheduledAt.optional(),
  /** An AI suggestion was applied while writing it. */
  aiAssisted: z.boolean().default(false),
});

/** Every field is optional; `scheduledAt: null` means "publish now". */
export const updatePostSchema = z.object({
  caption: z.string().max(10_000).optional(),
  mediaIds: z.array(uuid).max(10, "At most 10 media per post").optional(),
  targets: targets.optional(),
  scheduledAt: scheduledAt.nullable().optional(),
  aiAssisted: z.boolean().optional(),
});

export const listPostsQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional(),
  to: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional(),
  status: z
    .string()
    .transform((v) => v.split(",").filter(Boolean))
    .pipe(z.array(z.enum(["DRAFT", "SCHEDULED", "PUBLISHING", "PUBLISHED", "PARTIALLY_FAILED", "FAILED", "CANCELLED"])))
    .optional(),
});

export const registerMediaSchema = z.object({
  publicId: z.string().min(1).max(255),
  resourceType: z.enum(["image", "video"]),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;
export type UpdatePostInput = z.infer<typeof updatePostSchema>;
export type ListPostsQuery = z.infer<typeof listPostsQuerySchema>;
