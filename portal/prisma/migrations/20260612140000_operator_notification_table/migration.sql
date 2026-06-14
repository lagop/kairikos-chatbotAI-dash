-- CreateTable
-- KAIA-1061: OperatorNotification table for the smart-notification feature.
--
-- The operator is only emailed when (a) a client has been stuck for >N hours,
-- (b) an n8n execution failed, or (c) an escalation is needed. The
-- `OperatorNotification` table logs every send so the operator can see "you
-- were already notified about this" and so a `(clientId, kind, day)` unique
-- constraint can collapse duplicate firings within the same UTC day.
--
-- The `day` column is the UTC date (YYYY-MM-DD) of the notification, not a
-- timestamp, so the unique constraint is stable across timezones and the
-- route handler doesn't have to compute ranges. The optional
-- `clientId` column is NULLABLE: a non-client-scoped event (e.g. an n8n
-- execution that the portal can't link to a specific client row yet) still
-- needs to be deduped on `(clientId, kind, day)`. NULL is allowed in the
-- unique index so a NULL `clientId` doesn't block the row from being
-- inserted.
--
-- Reversibility: the rollback drops the table. Safe to apply because no
-- production feature depends on the table until the corresponding route
-- and the 3 n8n flows are live (acceptance gate from KAIA-1061).
CREATE TABLE "OperatorNotification" (
  "id" TEXT NOT NULL,
  "clientId" TEXT,
  -- One of: 'stuck' | 'execution-failed' | 'escalation'. Enforced
  -- server-side in the route handler — Postgres does not need its own
  -- check constraint because the route never writes an unknown value.
  "kind" TEXT NOT NULL,
  -- UTC date the notification fired (YYYY-MM-DD), used for dedup.
  "day" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  -- Free-form JSON-as-string with the request body that fired the
  -- notification (clientId, milestone, hoursSince, executionId, error,
  -- …). Lets the operator trace what triggered the email later.
  "context" TEXT,
  -- Resend message id, populated after a successful send. NULL means
  -- the send was deduped or failed.
  "resendMessageId" TEXT,
  "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OperatorNotification_pkey" PRIMARY KEY ("id")
);

-- Idempotency: at most one notification per (client, kind, day) tuple.
-- The unique index is partial — it ignores rows with a NULL clientId so
-- non-client-scoped events still get inserted, and it covers the
-- dedup query (`WHERE clientId = ? AND kind = ? AND day = ?`) so the
-- dedup check is a cheap index lookup.
CREATE UNIQUE INDEX "OperatorNotification_clientId_kind_day_key"
  ON "OperatorNotification" ("clientId", "kind", "day");

-- Common read paths:
--   * Operator inbox: "what fired today" → `WHERE day = ?`
--   * Per-client timeline: "what did we tell the operator about X" →
--     `WHERE clientId = ?`
--   * Resend webhook reconciliation: `WHERE resendMessageId = ?`
CREATE INDEX "OperatorNotification_day_idx" ON "OperatorNotification" ("day");
CREATE INDEX "OperatorNotification_resendMessageId_idx" ON "OperatorNotification" ("resendMessageId");
