-- CreateEnum
CREATE TYPE "metrics_status" AS ENUM ('PENDING', 'OK', 'UNAVAILABLE');

-- AlterTable
ALTER TABLE "social_accounts" ADD COLUMN     "audience_fetched_at" TIMESTAMPTZ(3),
ADD COLUMN     "insights_allowed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "post_target_metrics" (
    "post_target_id" UUID NOT NULL,
    "status" "metrics_status" NOT NULL DEFAULT 'PENDING',
    "views" INTEGER,
    "reach" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "total_interactions" INTEGER,
    "profile_visits" INTEGER,
    "follows" INTEGER,
    "avg_watch_time_ms" INTEGER,
    "fetched_at" TIMESTAMPTZ(3),
    "next_fetch_at" TIMESTAMPTZ(3),
    "fetch_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "post_target_metrics_pkey" PRIMARY KEY ("post_target_id")
);

-- CreateTable
CREATE TABLE "post_metric_snapshots" (
    "id" UUID NOT NULL,
    "post_target_id" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "views" INTEGER,
    "reach" INTEGER,
    "total_interactions" INTEGER,

    CONSTRAINT "post_metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_daily_stats" (
    "social_account_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "followers" INTEGER,
    "reach" INTEGER,
    "views" INTEGER,
    "accounts_engaged" INTEGER,
    "total_interactions" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "profile_links_taps" INTEGER,
    "follows" INTEGER,
    "unfollows" INTEGER,
    "insights_fetched_at" TIMESTAMPTZ(3),

    CONSTRAINT "account_daily_stats_pkey" PRIMARY KEY ("social_account_id","date")
);

-- CreateTable
CREATE TABLE "account_audience" (
    "social_account_id" UUID NOT NULL,
    "online_grid" JSONB,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_audience_pkey" PRIMARY KEY ("social_account_id")
);

-- CreateIndex
CREATE INDEX "post_target_metrics_next_fetch_at_idx" ON "post_target_metrics"("next_fetch_at");

-- CreateIndex
CREATE INDEX "post_metric_snapshots_post_target_id_captured_at_idx" ON "post_metric_snapshots"("post_target_id", "captured_at");

-- AddForeignKey
ALTER TABLE "post_target_metrics" ADD CONSTRAINT "post_target_metrics_post_target_id_fkey" FOREIGN KEY ("post_target_id") REFERENCES "post_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_metric_snapshots" ADD CONSTRAINT "post_metric_snapshots_post_target_id_fkey" FOREIGN KEY ("post_target_id") REFERENCES "post_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_daily_stats" ADD CONSTRAINT "account_daily_stats_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_audience" ADD CONSTRAINT "account_audience_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: accounts whose token already includes the insights permission.
UPDATE "social_accounts" a SET "insights_allowed" = true
FROM "oauth_tokens" t
WHERE t."social_account_id" = a."id" AND 'instagram_business_manage_insights' = ANY(t."scopes");
