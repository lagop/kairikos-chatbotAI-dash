-- CreateTable: N8nExecution (KAIA-1073)
-- Stores one row per n8n workflow execution so the operator flow-health
-- dashboard can show the last n8n status per client without querying n8n.
-- Upserted by POST /api/internal/n8n-execution; id is n8n's own exec id.

CREATE TABLE "N8nExecution" (
    "id"           TEXT NOT NULL,
    "clientId"     TEXT,
    "clientName"   TEXT,
    "workflow"     TEXT NOT NULL,
    "milestone"    TEXT,
    "status"       TEXT NOT NULL,
    "startedAt"    TIMESTAMPTZ NOT NULL,
    "finishedAt"   TIMESTAMPTZ,
    "errorCode"    TEXT,
    "errorMessage" TEXT,
    "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT "N8nExecution_pkey" PRIMARY KEY ("id")
);

-- FK to ChatbotClient (nullable — non-client-scoped workflows allowed)
ALTER TABLE "N8nExecution"
    ADD CONSTRAINT "N8nExecution_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "ChatbotClient"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Per-client history index
CREATE INDEX "N8nExecution_clientId_startedAt_idx"
    ON "N8nExecution" ("clientId", "startedAt" DESC);

-- Failure-listing dashboard index
CREATE INDEX "N8nExecution_status_startedAt_idx"
    ON "N8nExecution" ("status", "startedAt" DESC);
