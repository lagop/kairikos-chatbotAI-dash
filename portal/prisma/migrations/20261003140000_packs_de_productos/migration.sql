-- Plan de precios del 01/10/2026 — los packs de productos (Oficio, Presencia),
-- que sustituyen al «15 % por combinar». Aditiva.

-- 1. Los cupones de Stripe de cada pack, uno por intervalo de cobro.
CREATE TABLE "PackCoupon" (
    "id" UUID NOT NULL,
    "pack_code" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "stripe_coupon_id" TEXT NOT NULL,
    "amount_off_cents" INTEGER NOT NULL,
    "stripe_mode" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PackCoupon_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PackCoupon_stripe_coupon_id_key" ON "PackCoupon"("stripe_coupon_id");
CREATE UNIQUE INDEX "PackCoupon_pack_code_interval_key" ON "PackCoupon"("pack_code", "interval");

-- 2. Qué pack lleva cada suscripción (espejo de lo aplicado en Stripe).
ALTER TABLE "Subscription" ADD COLUMN "pack_code" TEXT;
ALTER TABLE "Subscription" ADD COLUMN "pack_applied_at" TIMESTAMP(3);
