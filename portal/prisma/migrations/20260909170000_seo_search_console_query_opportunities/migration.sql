-- SEO con IA — instantanea por consulta (query) de Search Console, la
-- senal de "oportunidad de contenido" (posicion 5-20) que el plan
-- original pedia pero nunca se construyo junto a la tendencia diaria.
-- Ver el comentario del modelo en schema.prisma.

CREATE TABLE "SeoSearchConsoleQuery" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoSearchConsoleQuery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeoSearchConsoleQuery_connection_id_query_key" ON "SeoSearchConsoleQuery"("connection_id", "query");
CREATE INDEX "SeoSearchConsoleQuery_client_id_idx" ON "SeoSearchConsoleQuery"("client_id");
CREATE INDEX "SeoSearchConsoleQuery_position_idx" ON "SeoSearchConsoleQuery"("position");

ALTER TABLE "SeoSearchConsoleQuery"
    ADD CONSTRAINT "SeoSearchConsoleQuery_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "GoogleSeoConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
