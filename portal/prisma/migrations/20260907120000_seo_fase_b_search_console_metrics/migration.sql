-- SEO con IA, Fase B — serie temporal diaria de metricas de Search Console
-- por conexion (clicks/impressions/ctr/position), para el grafico de
-- tendencia del informe del cliente. Ver el comentario del modelo en
-- schema.prisma.

CREATE TABLE "SeoSearchConsoleMetric" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoSearchConsoleMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeoSearchConsoleMetric_connection_id_date_key" ON "SeoSearchConsoleMetric"("connection_id", "date");
CREATE INDEX "SeoSearchConsoleMetric_client_id_idx" ON "SeoSearchConsoleMetric"("client_id");

ALTER TABLE "SeoSearchConsoleMetric"
    ADD CONSTRAINT "SeoSearchConsoleMetric_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "GoogleSeoConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
