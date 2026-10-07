-- CreateEnum
CREATE TYPE "Fulfilment" AS ENUM ('NOT_REQUIRED', 'TO_PRINT', 'PRINTING', 'DISPATCHED');

-- AlterTable
ALTER TABLE "order" ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "dispatched_at" TIMESTAMP(3),
ADD COLUMN     "fulfilment" "Fulfilment" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "refunded_pence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tracking_number" TEXT;

-- AlterTable
ALTER TABLE "support_request" ADD COLUMN     "resolved" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "support_reply" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_reply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_refund" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "amount_pence" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "staff_id" UUID NOT NULL,
    "stripe_refund_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_reply_request_id_idx" ON "support_reply"("request_id");

-- CreateIndex
CREATE INDEX "order_refund_order_id_idx" ON "order_refund"("order_id");

-- AddForeignKey
ALTER TABLE "support_reply" ADD CONSTRAINT "support_reply_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "support_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_refund" ADD CONSTRAINT "order_refund_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing paid orders with prints need printing.
UPDATE "order" o SET fulfilment = 'TO_PRINT' WHERE status = 'PAID' AND EXISTS (SELECT 1 FROM order_line l WHERE l.order_id = o.id AND NOT l.digital);
