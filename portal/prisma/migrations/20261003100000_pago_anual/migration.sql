-- Plan de precios del 01/10/2026 — el pago anual (12 meses por el precio de 10,
-- sin cuota de alta). Aditiva: dos columnas nuevas, ninguna borrada.
--
-- Product.stripe_annual_price_id: el Price recurrente anual de Stripe. NULL
-- hasta que el operador lo crea desde el panel, con segundo factor.
-- Subscription.billing_interval: 'month' | 'year'. Todas las suscripciones que
-- existen hoy son mensuales, y eso es justo lo que pone el DEFAULT.
ALTER TABLE "Product" ADD COLUMN "stripe_annual_price_id" TEXT;
CREATE UNIQUE INDEX "Product_stripe_annual_price_id_key" ON "Product"("stripe_annual_price_id");
ALTER TABLE "Subscription" ADD COLUMN "billing_interval" TEXT NOT NULL DEFAULT 'month';
