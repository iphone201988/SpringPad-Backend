-- CreateEnum
CREATE TYPE "OptionKind" AS ENUM ('SIZE', 'FRAME', 'EXTRA');

-- CreateTable
CREATE TABLE "product_option" (
    "code" TEXT NOT NULL,
    "kind" "OptionKind" NOT NULL,
    "label" TEXT NOT NULL,
    "hint" TEXT,
    "price_pence" INTEGER NOT NULL,
    "digital" BOOLEAN NOT NULL DEFAULT false,
    "swatch" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_option_pkey" PRIMARY KEY ("code")
);


ALTER TABLE "product_option" ADD CONSTRAINT "product_option_price_ok" CHECK (price_pence >= 0);

-- Today's catalogue (was hard-coded in src/catalog.ts).
INSERT INTO "product_option" (code, kind, label, hint, price_pence, digital, swatch, sort_order, updated_at) VALUES
  ('5x7', 'SIZE', '5 X 7 inch', 'Desk frame size', 2299, false, NULL, 1, now()),
  ('8x10', 'SIZE', '8 X 10 inch', 'Popular family gift', 2999, false, NULL, 2, now()),
  ('11x14', 'SIZE', '11 X 14 inch', 'Large Wall Mount', 3999, false, NULL, 3, now()),
  ('digital', 'SIZE', 'Digital File', 'Instant High-Res JPG', 1499, true, NULL, 4, now()),
  ('oak', 'FRAME', 'Natural Oak', NULL, 0, false, '#b07a45', 1, now()),
  ('black', 'FRAME', 'Sleek Black', NULL, 0, false, '#1f1f1f', 2, now()),
  ('gold', 'FRAME', 'Classic Gold', NULL, 0, false, '#c9a227', 3, now()),
  ('white', 'FRAME', 'White Wood', NULL, 0, false, '#f4f1ea', 4, now()),
  ('none', 'FRAME', 'Unframed', NULL, 0, false, NULL, 5, now()),
  ('mat', 'EXTRA', 'Archival mount', 'Added around the photo', 500, false, NULL, 1, now()),
  ('delivery', 'EXTRA', 'Delivery', 'Charged once per order with prints', 0, false, NULL, 2, now());
