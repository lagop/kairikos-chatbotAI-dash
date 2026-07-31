-- Rollback: KAIA-4263 — Onboarding wizard producto-agnóstico (self-serve)
--
-- Reverses the onboarding_sessions migration. No FKs into the new table
-- exist (the session is intentionally decoupled so backend tooling can
-- still operate if this rollback is run after Stripe webhook migration).
DROP INDEX IF EXISTS onboarding_sessions_stripe_session_idx;
DROP INDEX IF EXISTS onboarding_sessions_email_idx;
DROP INDEX IF EXISTS onboarding_sessions_status_idx;
DROP TABLE IF EXISTS onboarding_sessions;
