-- A11, capa 3 · Los borradores pedidos desde kairikos.com.
--
-- Cada fila es a la vez el borrador que se le enseña al visitante y el lead
-- que deja al pedirlo. La IP va hasheada: sirve para contar, no para
-- identificar.

CREATE TABLE IF NOT EXISTS "PublicDraftRequest" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "primary_type" TEXT NOT NULL,
    "theme_key" TEXT NOT NULL,
    "copy" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "contacted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicDraftRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PublicDraftRequest_token_key" ON "PublicDraftRequest"("token");
-- Los dos índices son para los topes: el global por día y el de cada IP.
CREATE INDEX IF NOT EXISTS "PublicDraftRequest_created_at_idx" ON "PublicDraftRequest"("created_at");
CREATE INDEX IF NOT EXISTS "PublicDraftRequest_ip_hash_created_at_idx"
    ON "PublicDraftRequest"("ip_hash", "created_at");
