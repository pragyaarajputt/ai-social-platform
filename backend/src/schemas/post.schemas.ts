import { z } from "zod";

const uuid = z.uuid("Invalid ID");

export const createPostSchema = z.object({
  caption: z.string().max(10_000).default(""),
  mediaIds: z.array(uuid).max(10, "At most 10 media per post").default([]),
  targets: z
    .array(
      z.object({
        socialAccountId: uuid,
        captionOverride: z.string().max(10_000).optional(),
      }),
    )
    .min(1, "Choose at least one account")
    .max(20),
});

export const registerMediaSchema = z.object({
  publicId: z.string().min(1).max(255),
  resourceType: z.enum(["image", "video"]),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;
