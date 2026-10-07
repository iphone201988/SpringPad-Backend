-- AlterTable
ALTER TABLE "order" ADD COLUMN     "discount_pence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promo_code" TEXT;

-- CreateTable
CREATE TABLE "promo_code" (
    "code" TEXT NOT NULL,
    "percent_off" INTEGER,
    "amount_off_pence" INTEGER,
    "min_subtotal_pence" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "max_redemptions" INTEGER,
    "redemptions" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_code_pkey" PRIMARY KEY ("code")
);


-- exactly one kind of discount, in range
ALTER TABLE "promo_code" ADD CONSTRAINT "promo_code_one_kind" CHECK ((percent_off IS NULL) <> (amount_off_pence IS NULL));
ALTER TABLE "promo_code" ADD CONSTRAINT "promo_code_percent_range" CHECK (percent_off BETWEEN 1 AND 100);
ALTER TABLE "promo_code" ADD CONSTRAINT "promo_code_amount_positive" CHECK (amount_off_pence > 0);
ALTER TABLE "promo_code" ADD CONSTRAINT "promo_code_upper" CHECK (code = upper(code));
