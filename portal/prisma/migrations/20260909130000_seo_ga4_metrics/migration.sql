-- SEO con IA — serie temporal diaria de metricas de GA4 por conexion
-- (usuarios/sesiones), para el grafico de tendencia del informe del
-- cliente. Ver el comentario del modelo en schema.prisma.

CREATE TABLE "SeoAnalyticsMetric" (
    "id" UUID NOT NULL,
    "connection_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "users" INTEGER NOT NULL,
    "sessions" INTEGER NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoAnalyticsMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeoAnalyticsMetric_connection_id_date_key" ON "SeoAnalyticsMetric"("connection_id", "date");
CREATE INDEX "SeoAnalyticsMetric_client_id_idx" ON "SeoAnalyticsMetric"("client_id");

ALTER TABLE "SeoAnalyticsMetric"
    ADD CONSTRAINT "SeoAnalyticsMetric_connection_id_fkey"
    FOREIGN KEY ("connection_id") REFERENCES "GoogleAnalyticsConnection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
