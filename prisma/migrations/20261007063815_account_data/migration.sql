-- AlterEnum
ALTER TYPE "EmailTokenType" ADD VALUE 'CHANGE_EMAIL';

-- AlterTable
ALTER TABLE "customer" ADD COLUMN     "display_name" TEXT,
ADD COLUMN     "stripe_customer_id" TEXT;

-- AlterTable
ALTER TABLE "email_token" ADD COLUMN     "new_email" TEXT;

-- CreateTable
CREATE TABLE "address" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "postcode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'United Kingdom',
    "is_default_shipping" BOOLEAN NOT NULL DEFAULT false,
    "is_default_billing" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "address_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "address_customer_id_idx" ON "address"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_stripe_customer_id_key" ON "customer"("stripe_customer_id");

-- AddForeignKey
ALTER TABLE "address" ADD CONSTRAINT "address_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

