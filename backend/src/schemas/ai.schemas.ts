import { z } from "zod";
import { REWRITE_ACTIONS, TONES } from "../ai/prompts.js";

const mediaIds = z.array(z.uuid("Invalid ID")).max(10, "At most 10 media per post").default([]);
const tone = z.enum(TONES);

export const captionsSchema = z
  .object({
    idea: z.string().trim().max(2000, "Keep the idea under 2,000 characters").default(""),
    mediaIds,
    tone: tone.optional(),
  })
  .refine((v) => v.idea.length > 0 || v.mediaIds.length > 0, { message: "Describe the post or add a photo first", path: ["idea"] });

export const hashtagsSchema = z
  .object({
    caption: z.string().max(5000).default(""),
    mediaIds,
  })
  .refine((v) => v.caption.trim().length > 0 || v.mediaIds.length > 0, { message: "Write a caption or add a photo first", path: ["caption"] });

export const rewriteSchema = z
  .object({
    text: z.string().trim().min(1, "Write a caption first").max(5000),
    action: z.enum(REWRITE_ACTIONS),
    tone: tone.optional(),
  })
  .refine((v) => v.action !== "tone" || v.tone !== undefined, { message: "Choose a tone", path: ["tone"] });

export const feedbackSchema = z
  .object({
    /** Which suggestion was applied (0-based); null to clear. */
    appliedIndex: z.number().int().min(0).max(20).nullable().optional(),
    rating: z.union([z.literal(1), z.literal(-1)]).nullable().optional(),
  })
  .refine((v) => v.appliedIndex !== undefined || v.rating !== undefined, { message: "Nothing to record" });

/** Empty strings clear a field. */
const voiceField = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `At most ${max} characters`)
    .transform((v) => v || null)
    .nullable()
    .default(null);

export const brandVoiceSchema = z.object({
  tone: voiceField(200),
  audience: voiceField(300),
  dos: voiceField(1000),
  donts: voiceField(1000),
  samplePost: voiceField(2200),
});

export type CaptionsInput = z.infer<typeof captionsSchema>;
export type HashtagsInput = z.infer<typeof hashtagsSchema>;
export type RewriteInput = z.infer<typeof rewriteSchema>;
export type FeedbackInput = z.infer<typeof feedbackSchema>;
export type BrandVoiceBody = z.infer<typeof brandVoiceSchema>;
