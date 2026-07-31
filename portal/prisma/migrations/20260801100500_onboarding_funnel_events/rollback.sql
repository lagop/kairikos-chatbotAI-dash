-- Rollback: KAIA-4263 — onboarding funnel events
DROP INDEX IF EXISTS onboarding_funnel_events_event_ts_idx;
DROP INDEX IF EXISTS onboarding_funnel_events_session_ts_idx;
DROP TABLE IF EXISTS onboarding_funnel_events;
