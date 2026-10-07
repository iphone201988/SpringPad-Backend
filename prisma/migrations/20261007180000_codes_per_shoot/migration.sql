-- AlterTable
ALTER TABLE "child_code" ADD COLUMN     "shoot_id" UUID;

-- CreateIndex
CREATE INDEX "child_code_shoot_id_idx" ON "child_code"("shoot_id");

-- AddForeignKey
ALTER TABLE "child_code" ADD CONSTRAINT "child_code_shoot_id_fkey" FOREIGN KEY ("shoot_id") REFERENCES "shoot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

