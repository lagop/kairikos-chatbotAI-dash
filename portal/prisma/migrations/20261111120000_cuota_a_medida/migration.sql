-- 11/11/2026 — cuota mensual a medida (mantenimiento con precio pactado).
-- Ver lib/custom-care.ts.

ALTER TABLE "ClientProduct"
  ADD COLUMN "custom_price_cents" INTEGER,
  ADD COLUMN "custom_trial_months" INTEGER;

ALTER TABLE "ClientProduct"
  ADD CONSTRAINT "ClientProduct_custom_price_positive" CHECK ("custom_price_cents" IS NULL OR "custom_price_cents" > 0),
  ADD CONSTRAINT "ClientProduct_custom_trial_range" CHECK ("custom_trial_months" IS NULL OR ("custom_trial_months" >= 0 AND "custom_trial_months" <= 24));

ALTER TABLE "WebQuote"
  ADD COLUMN "monthly_cents" INTEGER,
  ADD COLUMN "monthly_starts_after_months" INTEGER NOT NULL DEFAULT 12;

-- Una cuota de 0 € no existe: «sin mantenimiento» es NULL. Stripe aceptaría
-- una suscripción de 0 € y mandaría una factura vacía cada mes.
ALTER TABLE "WebQuote"
  ADD CONSTRAINT "WebQuote_monthly_positive" CHECK ("monthly_cents" IS NULL OR "monthly_cents" > 0),
  ADD CONSTRAINT "WebQuote_monthly_start_range" CHECK ("monthly_starts_after_months" >= 0 AND "monthly_starts_after_months" <= 24);
