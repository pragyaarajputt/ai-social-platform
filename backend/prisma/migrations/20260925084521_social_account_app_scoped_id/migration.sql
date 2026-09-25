-- AlterTable
ALTER TABLE "social_accounts" ADD COLUMN     "app_scoped_id" VARCHAR(100);

-- CreateIndex
CREATE INDEX "social_accounts_platform_app_scoped_id_idx" ON "social_accounts"("platform", "app_scoped_id");
