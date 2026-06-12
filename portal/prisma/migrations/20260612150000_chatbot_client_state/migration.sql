-- AddColumn
-- KAIA-1062: ChatbotClient.state — explicit onboarding-state column for
-- the client self-service flow.
--
-- Why a new column instead of overloading `goLiveAt`:
--   * `goLiveAt` is a DateTime? set by the CTO when the chatbot goes live.
--     It collapses three different states ("pending", "in-progress",
--     "go-live-pending") into a single nullable timestamp, so the portal
--     has no way to tell whether a non-null timestamp means "we accepted
--     the client's go-live-ready" or "we are still reviewing it".
--   * The self-service UI needs to express the new state "go-live-pending"
--     that the client explicitly requests via the "I'm ready for go-live"
--     button. The state machine is:
--       in-progress → go-live-pending → live
--     and `goLiveAt IS NULL` is ambiguous between the first two.
--
-- Allowed values (enforced server-side in the route handler — Postgres
-- does not need its own CHECK because the route never writes an unknown
-- value, mirroring the pattern in 20260612140000_operator_notification_table):
--   * 'in-progress'  — default for newly created clients
--   * 'go-live-pending' — client clicked "I'm ready for go-live" on the
--                         portal; the operator still has to confirm
--   * 'live'        — CTO confirmed go-live; goLiveAt is also set
--
-- Reversibility: the rollback drops the column. Safe because no other
-- feature depends on the new column before this issue ships.
ALTER TABLE "ChatbotClient"
  ADD COLUMN "state" TEXT NOT NULL DEFAULT 'in-progress';

-- Common read paths:
--   * "Which clients are awaiting go-live approval?" →
--     `WHERE state = 'go-live-pending'`
--   * Operator dashboard "needs my attention" view → `WHERE state IN (...)`
CREATE INDEX "ChatbotClient_state_idx" ON "ChatbotClient" ("state");
