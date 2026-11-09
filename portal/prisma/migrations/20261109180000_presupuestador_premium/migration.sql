-- Presupuestador de Kairikos Web Premium: los datos editables, por versiones,
-- y las solicitudes que llegan desde su página pública.
CREATE TABLE "PremiumQuoterVersion" (
    "id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "note" TEXT,
    "operator_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PremiumQuoterVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PremiumQuoterVersion_version_key" ON "PremiumQuoterVersion"("version");

CREATE TABLE "PremiumQuoteRequest" (
    "id" UUID NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "website" TEXT,
    "call_slot" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "estimate" JSONB NOT NULL,
    "config_version" INTEGER NOT NULL,
    "consent_at" TIMESTAMP(3) NOT NULL,
    "consent_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'nuevo',
    "status_changed_at" TIMESTAMP(3),
    "status_changed_by" TEXT,
    "contacted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PremiumQuoteRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PremiumQuoteRequest_status_created_at_idx" ON "PremiumQuoteRequest"("status", "created_at");
CREATE INDEX "PremiumQuoteRequest_ip_hash_created_at_idx" ON "PremiumQuoteRequest"("ip_hash", "created_at");
CREATE INDEX "PremiumQuoteRequest_created_at_idx" ON "PremiumQuoteRequest"("created_at");
