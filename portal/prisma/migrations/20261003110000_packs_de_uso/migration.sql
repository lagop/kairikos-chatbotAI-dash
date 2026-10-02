-- Plan de precios del 01/10/2026 — los packs de uso (+2.000 mensajes del
-- chatbot por 29 €, +100 negocios de prospección por 39 €). Aditiva.
--
-- 1. Product.kind: 'plan' para todo lo que ya existe; los packs son 'pack' y
--    no salen en la web, en /empezar ni en las altas de operador.
ALTER TABLE "Product" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'plan';

-- 2. El saldo comprado, que no caduca con el mes, y el aviso de tope del bot.
ALTER TABLE "ChatbotUsage" ADD COLUMN "pack_messages_remaining" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ChatbotUsage" ADD COLUMN "cap_alerted_at" TIMESTAMP(3);
ALTER TABLE "ProspectingCampaign" ADD COLUMN "pack_leads_remaining" INTEGER NOT NULL DEFAULT 0;

-- 3. Cada compra de un pack (ver el comentario del modelo).
CREATE TABLE "UsagePackPurchase" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "product_id" UUID NOT NULL,
    "pack_code" TEXT NOT NULL,
    "target_client_product_id" UUID NOT NULL,
    "units" INTEGER NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stripe_checkout_session_id" TEXT,
    "credited_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UsagePackPurchase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UsagePackPurchase_stripe_checkout_session_id_key" ON "UsagePackPurchase"("stripe_checkout_session_id");
CREATE INDEX "UsagePackPurchase_client_id_idx" ON "UsagePackPurchase"("client_id");
CREATE INDEX "UsagePackPurchase_target_client_product_id_idx" ON "UsagePackPurchase"("target_client_product_id");

-- 4. Las dos filas del catálogo. Precio de pago único (setup_fee_cents) y sin
--    cuota mensual; sin ids de Stripe ni autoservicio genérico: los crea el
--    Bootstrap del panel, con segundo factor, y se compran desde su propia
--    tarjeta (la del chatbot o la de prospección), nunca desde /empezar.
INSERT INTO "Product" ("id", "code", "tier", "name", "price_cents", "setup_fee_cents", "currency", "features", "is_active", "self_serve_eligible", "kind")
VALUES
  (gen_random_uuid(), 'pack_chatbot_messages', 'standard', 'Pack de +2.000 mensajes del chatbot', 0, 2900, 'EUR', '{}'::jsonb, true, false, 'pack'),
  (gen_random_uuid(), 'pack_prospecting_leads', 'standard', 'Pack de +100 negocios de prospección', 0, 3900, 'EUR', '{}'::jsonb, true, false, 'pack')
ON CONFLICT ("code", "tier") DO NOTHING;
