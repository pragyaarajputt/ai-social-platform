import { z } from "zod";

const base = {
  accountId: z.uuid("Invalid ID").optional(),
  days: z.coerce
    .number()
    .refine((d) => d === 7 || d === 30 || d === 90, "Choose 7, 30 or 90 days")
    .default(30),
};

export const analyticsQuerySchema = z.object(base);
export const topPostsQuerySchema = z.object({ ...base, sort: z.enum(["views", "reach", "interactions", "engagement", "recent"]).default("views") });
export const bestTimesQuerySchema = z.object({ accountId: base.accountId });

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type TopPostsQuery = z.infer<typeof topPostsQuerySchema>;
