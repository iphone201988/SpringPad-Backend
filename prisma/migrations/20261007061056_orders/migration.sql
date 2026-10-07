-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'CANCELLED', 'REFUNDED');

-- CreateTable
CREATE TABLE "basket_line" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "image_id" UUID NOT NULL,
    "size_code" TEXT NOT NULL,
    "frame_code" TEXT NOT NULL,
    "mat" BOOLEAN NOT NULL DEFAULT false,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "basket_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "customer_id" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "subtotal_pence" INTEGER NOT NULL,
    "delivery_pence" INTEGER NOT NULL,
    "total_pence" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "shipping" JSONB NOT NULL,
    "stripe_session_id" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "image_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "size_code" TEXT NOT NULL,
    "frame_code" TEXT NOT NULL,
    "mat" BOOLEAN NOT NULL,
    "digital" BOOLEAN NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price_pence" INTEGER NOT NULL,

    CONSTRAINT "order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlement" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "image_id" UUID NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "basket_line_customer_id_idx" ON "basket_line"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_number_key" ON "order"("number");

-- CreateIndex
CREATE UNIQUE INDEX "order_stripe_session_id_key" ON "order"("stripe_session_id");

-- CreateIndex
CREATE INDEX "order_customer_id_created_at_idx" ON "order"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "order_line_order_id_idx" ON "order_line"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "entitlement_order_line_id_key" ON "entitlement"("order_line_id");

-- CreateIndex
CREATE INDEX "entitlement_customer_id_idx" ON "entitlement"("customer_id");

-- AddForeignKey
ALTER TABLE "basket_line" ADD CONSTRAINT "basket_line_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "basket_line" ADD CONSTRAINT "basket_line_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "image_asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order" ADD CONSTRAINT "order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line" ADD CONSTRAINT "order_line_image_id_fkey" FOREIGN KEY ("image_id") REFERENCES "image_asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_line"("id") ON DELETE CASCADE ON UPDATE CASCADE;
