-- CreateEnum
CREATE TYPE "ai_feature" AS ENUM ('CAPTIONS', 'HASHTAGS', 'REWRITE');

-- CreateEnum
CREATE TYPE "ai_request_status" AS ENUM ('PENDING', 'OK', 'REFUSED', 'ERROR', 'QUOTA_EXCEEDED', 'SPEND_CAP_REACHED');

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "ai_assisted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ai_requests" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "user_id" UUID,
    "feature" "ai_feature" NOT NULL,
    "model" VARCHAR(60) NOT NULL,
    "prompt_version" VARCHAR(30) NOT NULL,
    "status" "ai_request_status" NOT NULL DEFAULT 'PENDING',
    "error_code" VARCHAR(40),
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micros" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER,
    "output" JSONB,
    "applied_index" INTEGER,
    "rating" SMALLINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "ai_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_voices" (
    "workspace_id" UUID NOT NULL,
    "tone" VARCHAR(200),
    "audience" VARCHAR(300),
    "dos" VARCHAR(1000),
    "donts" VARCHAR(1000),
    "sample_post" VARCHAR(2200),
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "brand_voices_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateIndex
CREATE INDEX "ai_requests_workspace_id_created_at_idx" ON "ai_requests"("workspace_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_requests_created_at_idx" ON "ai_requests"("created_at");

-- AddForeignKey
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_requests" ADD CONSTRAINT "ai_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_voices" ADD CONSTRAINT "brand_voices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_voices" ADD CONSTRAINT "brand_voices_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
