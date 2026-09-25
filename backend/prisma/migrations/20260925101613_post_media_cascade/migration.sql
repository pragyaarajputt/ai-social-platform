-- DropForeignKey
ALTER TABLE "post_media" DROP CONSTRAINT "post_media_media_asset_id_fkey";

-- AddForeignKey
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
