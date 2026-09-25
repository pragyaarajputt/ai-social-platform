-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "post_status" ADD VALUE 'SCHEDULED';
ALTER TYPE "post_status" ADD VALUE 'CANCELLED';

-- AlterEnum
ALTER TYPE "target_status" ADD VALUE 'SCHEDULED';

-- AlterTable
ALTER TABLE "post_targets" ADD COLUMN     "preflight_warned_at" TIMESTAMPTZ(3),
ADD COLUMN     "scheduled_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "scheduled_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "posts_workspace_id_scheduled_at_idx" ON "posts"("workspace_id", "scheduled_at");
