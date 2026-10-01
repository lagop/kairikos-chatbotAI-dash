-- Plan de precios del 01/10/2026 (documento del plan de marketing, sección
-- «Plan de precios propuesto»).
--
-- 1. El escalón nuevo de Llamadas: Esencial, 79 €/mes + 99 € de alta. Coge la
--    llamada, manda el recado transcrito por WhatsApp y escribe a quien llamó;
--    sin franjas, resumen diario ni informe mensual (RECALL_ESSENTIAL_TIERS en
--    lib/recall.ts). Nace sin ids de Stripe y sin autoservicio, como los otros
--    tres de 'recall': los crea el Bootstrap de /admin/portal/settings/billing,
--    con segundo factor.
--
-- 2. El Starter del chatbot pasa a llamarse por lo que hace: Web. Solo el
--    nombre; el código del escalón ('starter') lo llevan Stripe, las
--    suscripciones y el asistente, y no se toca.
--
-- Los importes de los escalones que ya existen NO se cambian aquí: tienen
-- precio en Stripe, y cambiarlos solo en Postgres dejaría la página de
-- precios diciendo una cifra y el cobro otra. Van por «Cambiar precio» del
-- mismo panel, que crea el precio nuevo en Stripe y actualiza la fila.
--
-- Idempotente: se puede aplicar dos veces sin efecto la segunda.
INSERT INTO "Product" ("id", "code", "tier", "name", "price_cents", "setup_fee_cents", "currency", "features", "is_active", "self_serve_eligible")
VALUES (gen_random_uuid(), 'recall', 'essential', 'Recuperación de llamadas — Esencial', 7900, 9900, 'EUR', '{}'::jsonb, true, false)
ON CONFLICT ("code", "tier") DO NOTHING;

UPDATE "Product" SET "name" = 'Chatbot IA — Web'
WHERE "code" = 'chatbot' AND "tier" = 'starter' AND "name" = 'Chatbot IA — Starter';
