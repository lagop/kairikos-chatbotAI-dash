-- Webs con IA, entrega 6 (27/10/2026): el SEO publica en una web de Kairikos.
-- SeoProfile no lleva @@map: la tabla es "SeoProfile"; la columna nueva va en
-- snake_case por su @map, como el resto de las del modelo.
ALTER TABLE "SeoProfile" ADD COLUMN "website_id" UUID;
ALTER TABLE "SeoProfile"
  ADD CONSTRAINT "SeoProfile_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "ClientWebsite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "SeoProfile_website_id_idx" ON "SeoProfile"("website_id");
