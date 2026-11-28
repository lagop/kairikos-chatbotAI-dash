-- Informe mensual de resultados de la web Premium (28/11/2026),
-- docs/informe-mensual-web.md.
--
-- 1. client_site gana el token público de eventos (wev_…) y el cursor del
--    informe mensual. Aditivas y nullable: un sitio sin token no mide nada.
-- 2. Tabla nueva web_event_day: contadores diarios agregados, sin IP ni
--    identificador de visitante. `source` es '' (no NULL) cuando no aplica,
--    para que el índice único funcione: dos NULL no chocan y el
--    ON CONFLICT de la ruta pública abriría una fila por evento.
--    `day` es el día local de Canarias.
-- Sin DEFAULT en "id": Prisma genera el uuid en la aplicación, y la ruta
-- pública, que inserta con SQL directo, usa gen_random_uuid() (nativa desde
-- Postgres 13).

ALTER TABLE "client_site" ADD COLUMN "events_token" TEXT;
ALTER TABLE "client_site" ADD COLUMN "last_results_report_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "client_site_events_token_key" ON "client_site"("events_token");

CREATE TABLE "web_event_day" (
    "id" UUID NOT NULL,
    "client_site_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_event_day_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "web_event_day_client_site_id_day_kind_source_key" ON "web_event_day"("client_site_id", "day", "kind", "source");

CREATE INDEX "web_event_day_client_site_id_day_idx" ON "web_event_day"("client_site_id", "day");

ALTER TABLE "web_event_day" ADD CONSTRAINT "web_event_day_client_site_id_fkey" FOREIGN KEY ("client_site_id") REFERENCES "client_site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
