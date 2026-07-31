-- Migration: KAIA-4263 — onboarding funnel events
--
-- Append-only log of wizard funnel events emitted by the React
-- self-serve onboarding context. Anonymous, no FKs into the multi-tenant
-- schema. The owner-facing view at /admin/portal/onboarding-funnel can
-- compute drop-off in pure SQL once these rows accumulate.
--
-- Reversibility: see rollback.sql. The single new table + its indexes
-- are dropped; no other migration references this table yet.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS onboarding_funnel_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event          TEXT NOT NULL,
  session_token  TEXT NOT NULL,
  step           TEXT,
  reason         TEXT,
  path           TEXT NOT NULL,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS onboarding_funnel_events_session_ts_idx
  ON onboarding_funnel_events (session_token, ts);
CREATE INDEX IF NOT EXISTS onboarding_funnel_events_event_ts_idx
  ON onboarding_funnel_events (event, ts);
