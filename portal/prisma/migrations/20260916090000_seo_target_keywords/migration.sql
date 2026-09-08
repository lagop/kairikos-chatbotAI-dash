-- Fase 3.1 — palabras clave objetivo y su histórico de posiciones.
--
-- SeoSearchConsoleQuery se reemplaza entera en cada sincronización (es una
-- foto del presente), así que el seguimiento en el tiempo necesita tabla
-- propia. Solo entran las palabras que el cliente persigue, de modo que el
-- volumen lo acota su propia lista.

CREATE TABLE "SeoTargetKeyword" (
    "id" UUID NOT NULL,
    "profile_id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "tenant_id" UUID,
    "keyword" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoTargetKeyword_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeoTargetKeyword_profile_id_keyword_key" ON "SeoTargetKeyword"("profile_id", "keyword");
CREATE INDEX "SeoTargetKeyword_client_id_idx" ON "SeoTargetKeyword"("client_id");
CREATE INDEX "SeoTargetKeyword_tenant_id_idx" ON "SeoTargetKeyword"("tenant_id");

ALTER TABLE "SeoTargetKeyword"
    ADD CONSTRAINT "SeoTargetKeyword_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "SeoProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SeoTargetKeyword"
    ADD CONSTRAINT "SeoTargetKeyword_client_id_fkey"
    FOREIGN KEY ("client_id") REFERENCES "ChatbotClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SeoTargetKeyword"
    ADD CONSTRAINT "SeoTargetKeyword_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Un punto por palabra y día. position NULL = ese día no apareció en
-- Search Console, que es un dato distinto de "posición 0".
CREATE TABLE "SeoKeywordPosition" (
    "id" UUID NOT NULL,
    "target_keyword_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "position" DOUBLE PRECISION,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeoKeywordPosition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SeoKeywordPosition_target_keyword_id_date_key" ON "SeoKeywordPosition"("target_keyword_id", "date");
CREATE INDEX "SeoKeywordPosition_target_keyword_id_date_idx" ON "SeoKeywordPosition"("target_keyword_id", "date");

ALTER TABLE "SeoKeywordPosition"
    ADD CONSTRAINT "SeoKeywordPosition_target_keyword_id_fkey"
    FOREIGN KEY ("target_keyword_id") REFERENCES "SeoTargetKeyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;
