-- La URL y el secreto del webhook de leads, cifrados (ver LeadWebhook y
-- lead-webhook-crypto.ts). Aditiva a propósito: las columnas en claro pasan
-- a opcionales y se dejan de usar, pero no se borran todavía, para que el
-- contenedor anterior siga funcionando hasta que llegue el despliegue.
-- El 30/09/2026 no había ninguna fila en producción que migrar.
ALTER TABLE "LeadWebhook" ADD COLUMN "url_ciphertext" BYTEA;
ALTER TABLE "LeadWebhook" ADD COLUMN "url_iv" BYTEA;
ALTER TABLE "LeadWebhook" ADD COLUMN "url_tag" BYTEA;
ALTER TABLE "LeadWebhook" ADD COLUMN "secret_ciphertext" BYTEA;
ALTER TABLE "LeadWebhook" ADD COLUMN "secret_iv" BYTEA;
ALTER TABLE "LeadWebhook" ADD COLUMN "secret_tag" BYTEA;
ALTER TABLE "LeadWebhook" ALTER COLUMN "url" DROP NOT NULL;
ALTER TABLE "LeadWebhook" ALTER COLUMN "secret" DROP NOT NULL;
