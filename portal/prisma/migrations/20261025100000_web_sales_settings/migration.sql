-- 25/10/2026 — tope mensual de webs vendidas por autoservicio desde el
-- borrador. Singleton (ver lib/web-self-serve.ts): la fila nace la primera vez
-- que el operador guarda; mientras no exista, el código usa 4.
CREATE TABLE "web_sales_settings" (
    "id" UUID NOT NULL,
    "self_serve_monthly_cap" INTEGER NOT NULL DEFAULT 4,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "web_sales_settings_pkey" PRIMARY KEY ("id")
);
