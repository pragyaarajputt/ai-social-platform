-- CreateEnum
CREATE TYPE "media_type" AS ENUM ('IMAGE', 'VIDEO');

-- CreateEnum
CREATE TYPE "post_status" AS ENUM ('DRAFT', 'PUBLISHING', 'PUBLISHED', 'PARTIALLY_FAILED', 'FAILED');

-- CreateEnum
CREATE TYPE "post_format" AS ENUM ('IMAGE', 'CAROUSEL', 'REEL');

-- CreateEnum
CREATE TYPE "target_status" AS ENUM ('QUEUED', 'PUBLISHING', 'WAITING_FOR_MEDIA', 'PUBLISHED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "uploaded_by_id" UUID,
    "public_id" VARCHAR(255) NOT NULL,
    "type" "media_type" NOT NULL,
    "format" VARCHAR(20) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "duration_sec" DOUBLE PRECISION,
    "secure_url" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "author_id" UUID,
    "caption" TEXT NOT NULL DEFAULT '',
    "status" "post_status" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_media" (
    "post_id" UUID NOT NULL,
    "media_asset_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "post_media_pkey" PRIMARY KEY ("post_id","position")
);

-- CreateTable
CREATE TABLE "post_targets" (
    "id" UUID NOT NULL,
    "post_id" UUID NOT NULL,
    "social_account_id" UUID NOT NULL,
    "caption_override" TEXT,
    "format" "post_format" NOT NULL,
    "status" "target_status" NOT NULL DEFAULT 'QUEUED',
    "next_attempt_at" TIMESTAMPTZ(3),
    "locked_until" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "platform_state" JSONB NOT NULL DEFAULT '{}',
    "external_post_id" VARCHAR(100),
    "permalink" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "last_error_code" VARCHAR(40),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "post_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_attempts" (
    "id" UUID NOT NULL,
    "post_target_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "outcome" VARCHAR(30) NOT NULL,
    "error_code" VARCHAR(40),
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "publish_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "media_assets_workspace_id_created_at_idx" ON "media_assets"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_workspace_id_public_id_key" ON "media_assets"("workspace_id", "public_id");

-- CreateIndex
CREATE INDEX "posts_workspace_id_created_at_idx" ON "posts"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "post_media_media_asset_id_idx" ON "post_media"("media_asset_id");

-- CreateIndex
CREATE INDEX "post_targets_status_next_attempt_at_idx" ON "post_targets"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "post_targets_social_account_id_idx" ON "post_targets"("social_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_targets_post_id_social_account_id_key" ON "post_targets"("post_id", "social_account_id");

-- CreateIndex
CREATE INDEX "publish_attempts_post_target_id_started_at_idx" ON "publish_attempts"("post_target_id", "started_at");

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_post_target_id_fkey" FOREIGN KEY ("post_target_id") REFERENCES "post_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Manual: constraints Prisma schema can't express
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_position_chk" CHECK ("position" >= 0 AND "position" < 10);
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_attempts_chk" CHECK ("attempts" >= 0);
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_dimensions_chk" CHECK ("bytes" >= 0 AND "width" >= 0 AND "height" >= 0);
