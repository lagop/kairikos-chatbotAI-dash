-- Fase 1 multi-instancia, migración 2 de 4 — cada contratación apunta a un
-- sitio del cliente.
--
-- Nullable a propósito y PARA SIEMPRE, no solo durante la migración: una
-- contratación sin sitio declarado resuelve al sitio primario del cliente
-- (resolveContractedInstance en lib/client-product-access.ts). Eso mantiene
-- simple el alta de operador, que no tiene por qué elegir sitio.
--
-- ON DELETE SET NULL y no CASCADE: borrar un sitio jamás debe llevarse por
-- delante la contratación —y con ella la suscripción de Stripe, las facturas
-- y el histórico—. Por eso además los sitios se archivan (archived_at) en vez
-- de borrarse.

ALTER TABLE "ClientProduct" ADD COLUMN "client_site_id" UUID;

ALTER TABLE "ClientProduct"
    ADD CONSTRAINT "ClientProduct_client_site_id_fkey"
    FOREIGN KEY ("client_site_id") REFERENCES "client_site"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ClientProduct_client_site_id_idx" ON "ClientProduct" ("client_site_id");
