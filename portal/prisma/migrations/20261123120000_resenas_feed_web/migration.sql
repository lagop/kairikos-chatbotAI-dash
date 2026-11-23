-- Reseñas en la web Premium (23/11/2026): el feed que lee cada noche la build de la web del cliente.
-- Columnas nuevas, todas opcionales: no hay que rellenar nada.
ALTER TABLE "GoogleBusinessConnection" ADD COLUMN "website_feed_token_hash" TEXT,
ADD COLUMN "website_feed_read_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "GoogleBusinessConnection_website_feed_token_hash_key" ON "GoogleBusinessConnection"("website_feed_token_hash");

-- La reseña ya no está en Google: se guarda, pero no sale en la web.
ALTER TABLE "GoogleReview" ADD COLUMN "removed_at" TIMESTAMP(3);
