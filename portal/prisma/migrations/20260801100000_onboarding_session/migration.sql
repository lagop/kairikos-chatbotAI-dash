-- Migration: KAIA-4263 — Onboarding wizard producto-agnóstico (self-serve)
--
-- Adds:
--   1. onboarding_sessions — one row per anonymous wizard run. Holds the
--                              wizard session token, the idempotency key,
--                              the selected product tier, the captured
--                              minimum configuration, and the Stripe
--                              checkout session id. Status starts as
--                              'pending' and is flipped to 'active' by
--                              the Stripe webhook (KAIA-4262) after the
--                              first successful payment.
--
-- Reversibility: see rollback.sql. The single new table is dropped in
-- dependency order with all FKs to portal/tenant data left as-is so the
-- migration is reversible without dropping multi-tenant state.
--
-- Idempotency design (KAIA-4263 domain lens):
--   * onboarding_sessions.idempotency_key UNIQUE so retries on the
--     /api/onboarding/start endpoint never create a second tenant.
--   * onboarding_sessions.session_token UNIQUE so the wizard token
--     used by the React context is also the DB business key.
--   * onboarding_sessions.tenant_slug UNIQUE so the wizard's
--     pre-reserved slug does not collide with existing tenants.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. onboarding_sessions
-- ============================================================================
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token            TEXT NOT NULL UNIQUE,
  idempotency_key          TEXT NOT NULL UNIQUE,
  email                    TEXT NOT NULL,
  tenant_slug              TEXT NOT NULL UNIQUE,
  product_tier             TEXT,
  product_id               UUID,
  client_product_id        UUID,
  business_name            TEXT,
  sector                   TEXT,
  whatsapp                 TEXT,
  contact_email            TEXT,
  stripe_checkout_session_id TEXT,
  stripe_customer_id       TEXT,
  client_id                TEXT,
  tenant_id                UUID,
  status                   TEXT NOT NULL DEFAULT 'pending',
  activation_at            TIMESTAMPTZ,
  abandoned_reason         TEXT,
  source                   TEXT NOT NULL DEFAULT 'self_serve_landing',
  expires_at               TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS onboarding_sessions_status_idx ON onboarding_sessions (status);
CREATE INDEX IF NOT EXISTS onboarding_sessions_email_idx ON onboarding_sessions (email);
CREATE INDEX IF NOT EXISTS onboarding_sessions_stripe_session_idx ON onboarding_sessions (stripe_checkout_session_id);
