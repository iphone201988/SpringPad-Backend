-- CreateTable
CREATE TABLE "shoot_photo" (
    "id" UUID NOT NULL,
    "shoot_id" UUID NOT NULL,
    "master_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "captured_at" TIMESTAMP(3),
    "decode_kind" TEXT NOT NULL,
    "decoded_child_id" UUID,
    "decoded_unknown" BOOLEAN NOT NULL DEFAULT false,
    "override_child_id" UUID,
    "override_not_anchor" BOOLEAN NOT NULL DEFAULT false,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "run_approved" BOOLEAN NOT NULL DEFAULT false,
    "image_id" UUID,
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shoot_photo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shoot_photo_image_id_key" ON "shoot_photo"("image_id");

-- CreateIndex
CREATE INDEX "shoot_photo_shoot_id_idx" ON "shoot_photo"("shoot_id");

-- CreateIndex
CREATE UNIQUE INDEX "shoot_photo_shoot_id_sha256_key" ON "shoot_photo"("shoot_id", "sha256");

-- AddForeignKey
ALTER TABLE "shoot_photo" ADD CONSTRAINT "shoot_photo_shoot_id_fkey" FOREIGN KEY ("shoot_id") REFERENCES "shoot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shoot_photo" ADD CONSTRAINT "shoot_photo_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "image_asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

