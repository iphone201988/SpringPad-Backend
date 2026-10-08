-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "entitlement" ADD COLUMN     "job_id" UUID,
ALTER COLUMN "image_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "guardian_invite" ADD COLUMN     "staff_id" UUID,
ALTER COLUMN "invited_by_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "order_line" ADD COLUMN     "job_id" UUID,
ALTER COLUMN "image_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "generation_job" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "input_image_ids" UUID[],
    "preview_key" TEXT,
    "result_key" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "generation_job_customer_id_idx" ON "generation_job"("customer_id");

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "generation_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "generation_job"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_job" ADD CONSTRAINT "generation_job_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Exactly one target per order line / entitlement (a photo or a generated product), and one sender per invite.
-- Prisma can't express these, so they live only here.
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_one_product" CHECK (num_nonnulls("image_id", "job_id") = 1);
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_one_product" CHECK (num_nonnulls("image_id", "job_id") = 1);
ALTER TABLE "guardian_invite" ADD CONSTRAINT "guardian_invite_one_sender" CHECK (num_nonnulls("invited_by_id", "staff_id") = 1);
