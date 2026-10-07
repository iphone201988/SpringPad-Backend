-- CreateEnum
CREATE TYPE "ImageSource" AS ENUM ('SPRINGPAD', 'PARENT_UPLOAD');

-- CreateTable
CREATE TABLE "shoot" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "academic_year" TEXT NOT NULL,
    "taken_on" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shoot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "image_asset" (
    "id" UUID NOT NULL,
    "child_id" UUID NOT NULL,
    "shoot_id" UUID,
    "reference" TEXT NOT NULL,
    "source" "ImageSource" NOT NULL DEFAULT 'SPRINGPAD',
    "is_anchor" BOOLEAN NOT NULL DEFAULT false,
    "master_key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "rights" JSONB,
    "captured_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "image_asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "favourite" (
    "customer_id" UUID NOT NULL,
    "image_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favourite_pkey" PRIMARY KEY ("customer_id","image_id")
);

-- CreateIndex
CREATE INDEX "shoot_school_id_idx" ON "shoot"("school_id");

-- CreateIndex
CREATE INDEX "image_asset_child_id_is_anchor_idx" ON "image_asset"("child_id", "is_anchor");

-- AddForeignKey
ALTER TABLE "shoot" ADD CONSTRAINT "shoot_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "school"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_asset" ADD CONSTRAINT "image_asset_child_id_fkey" FOREIGN KEY ("child_id") REFERENCES "child"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_asset" ADD CONSTRAINT "image_asset_shoot_id_fkey" FOREIGN KEY ("shoot_id") REFERENCES "shoot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favourite" ADD CONSTRAINT "favourite_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favourite" ADD CONSTRAINT "favourite_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "image_asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
