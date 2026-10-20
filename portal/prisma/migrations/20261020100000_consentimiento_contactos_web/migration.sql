-- 20/10/2026 — consentimiento para comunicaciones comerciales en las dos
-- herramientas públicas de kairikos.com que recogen un contacto. Null = sin
-- consentimiento. Solo añade columnas que admiten nulos: no toca filas.
ALTER TABLE "PublicDraftRequest" ADD COLUMN IF NOT EXISTS "marketing_consent_at" TIMESTAMP(3);
ALTER TABLE "CalculatorLead" ADD COLUMN IF NOT EXISTS "marketing_consent_at" TIMESTAMP(3);
