-- CreateEnum
CREATE TYPE "workspace_role" AS ENUM ('OWNER', 'ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "social_platform" AS ENUM ('INSTAGRAM', 'FACEBOOK', 'THREADS', 'LINKEDIN', 'X', 'YOUTUBE', 'TIKTOK');

-- CreateEnum
CREATE TYPE "social_account_status" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'REVOKED', 'DISCONNECTED');

-- DropForeignKey
ALTER TABLE "blocks" DROP CONSTRAINT "blocks_target_user_id_fkey";

-- DropForeignKey
ALTER TABLE "blocks" DROP CONSTRAINT "blocks_user_id_fkey";

-- DropForeignKey
ALTER TABLE "follows" DROP CONSTRAINT "follows_follower_id_fkey";

-- DropForeignKey
ALTER TABLE "follows" DROP CONSTRAINT "follows_following_id_fkey";

-- DropForeignKey
ALTER TABLE "mutes" DROP CONSTRAINT "mutes_target_user_id_fkey";

-- DropForeignKey
ALTER TABLE "mutes" DROP CONSTRAINT "mutes_user_id_fkey";

-- AlterTable
ALTER TABLE "profiles" DROP COLUMN "bio",
DROP COLUMN "cover_url",
DROP COLUMN "interests",
DROP COLUMN "is_private",
DROP COLUMN "location",
DROP COLUMN "website";

-- DropTable
DROP TABLE "blocks";

-- DropTable
DROP TABLE "follows";

-- DropTable
DROP TABLE "mutes";

-- DropEnum
DROP TYPE "follow_status";

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(60) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "workspace_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "workspace_role" NOT NULL DEFAULT 'EDITOR',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("workspace_id","user_id")
);

-- CreateTable
CREATE TABLE "social_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "platform" "social_platform" NOT NULL,
    "external_id" VARCHAR(100) NOT NULL,
    "account_type" VARCHAR(30),
    "username" VARCHAR(100),
    "name" VARCHAR(200),
    "avatar_url" TEXT,
    "status" "social_account_status" NOT NULL DEFAULT 'ACTIVE',
    "connected_by_id" UUID,
    "last_checked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_tokens" (
    "social_account_id" UUID NOT NULL,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_refreshed_at" TIMESTAMPTZ(3),
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "oauth_tokens_pkey" PRIMARY KEY ("social_account_id")
);

-- CreateTable
CREATE TABLE "oauth_connect_states" (
    "id" UUID NOT NULL,
    "state_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "platform" "social_platform" NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_connect_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID,
    "actor_id" UUID,
    "action" VARCHAR(80) NOT NULL,
    "target_type" VARCHAR(40),
    "target_id" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspace_members_user_id_idx" ON "workspace_members"("user_id");

-- CreateIndex
CREATE INDEX "social_accounts_platform_external_id_idx" ON "social_accounts"("platform", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_accounts_workspace_id_platform_external_id_key" ON "social_accounts"("workspace_id", "platform", "external_id");

-- CreateIndex
CREATE INDEX "oauth_tokens_expires_at_idx" ON "oauth_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_connect_states_state_hash_key" ON "oauth_connect_states"("state_hash");

-- CreateIndex
CREATE INDEX "audit_logs_workspace_id_created_at_idx" ON "audit_logs"("workspace_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_social_account_id_fkey" FOREIGN KEY ("social_account_id") REFERENCES "social_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_connect_states" ADD CONSTRAINT "oauth_connect_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_connect_states" ADD CONSTRAINT "oauth_connect_states_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Manual: constraints Prisma schema can't express
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_slug_format_chk" CHECK ("slug" ~ '^[a-z0-9][a-z0-9-]*$');

-- Manual backfill: every existing user gets a personal workspace they own.
-- New users get one at sign-up (auth.service.ts).
WITH new_workspaces AS (
    INSERT INTO "workspaces" ("id", "name", "slug", "timezone", "created_at", "updated_at")
    SELECT uuidv7(),
           left(coalesce(p."display_name", u."username") || '''s workspace', 80),
           'ws-' || substr(md5(u."id"::text), 1, 12),
           'UTC',
           now(),
           now()
    FROM "users" u
    LEFT JOIN "profiles" p ON p."user_id" = u."id"
    WHERE NOT EXISTS (SELECT 1 FROM "workspace_members" m WHERE m."user_id" = u."id")
    RETURNING "id", "slug"
)
INSERT INTO "workspace_members" ("workspace_id", "user_id", "role", "created_at")
SELECT w."id", u."id", 'OWNER', now()
FROM new_workspaces w
JOIN "users" u ON w."slug" = 'ws-' || substr(md5(u."id"::text), 1, 12);
