-- KAIA-1261 (BE-1 v1) — Operator identity precondition.
--
-- KAIA-1107 (per-operator identity: email + password + TOTP MFA) requires
-- the `Operator`, `OperatorSession`, and `OperatorRecoveryCode` tables so
-- the wizard can:
--   * reference the operator who approved a step (FK
--     ChatbotConfigStep.approvedByOperatorId -> Operator.id);
--   * run the admin-portal session model (KAIA-1166 / BE-3 routes
--     authenticate against OperatorSession);
--   * support the TOTP recovery flow (OperatorRecoveryCode).
--
-- The model definitions were already in the working copy of
-- `prisma/schema.prisma` at the time of KAIA-1163, but no migration was
-- ever written for them — so `prisma migrate deploy` on a fresh database
-- fails at `20260613110000_chatbot_config_step_table` with:
--   42P01  relation "Operator" does not exist
-- This migration closes that gap so the whole chain applies.
--
-- Schema is the same as the v0.2 spec captured in the issue thread (cuid
-- for ChatbotConfigStep.id, UUID for Operator.id via @db.Uuid). The cuid
-- vs uuid split is intentional: Operator rows cross the boundary into
-- 1Password Service Account references (UUIDs there) and Supabase
-- Auth mapping (UUIDs there), so an early @db.Uuid adoption is cheap.
--
-- Rollback (rollback.sql):
--   * DROP TABLE "OperatorRecoveryCode" — no FKs to it
--   * DROP TABLE "OperatorSession"       — no FKs to it
--   * DROP TABLE "Operator"              — breaks ChatbotConfigStep
--                                          and (after KAIA-1082)
--                                          OperatorSettingsAudit
-- The rollback is therefore safe only before the wizard v1 API (BE-2/3)
-- and KAIA-1082 start writing against these tables.
--
-- Note on the `OperatorSettings.actorOperatorId` UUID column: it is
-- declared in 20260613090000_operator_settings_table WITHOUT an FK to
-- Operator (the comment there notes "FK to a future Operator identity
-- model — nullable until KAIA-1082 lands"). This migration does NOT add
-- a back-fill FK there; that is KAIA-1082's job and would require a
-- separate migration once that work starts.

-- ── Operator ────────────────────────────────────────────────────────────

CREATE TABLE "Operator" (
    "id"             UUID         NOT NULL,
    "email"          TEXT         NOT NULL,
    "passwordHash"   TEXT         NOT NULL,
    -- Encrypted TOTP secret (AES-256-GCM with OPERATOR_TOTP_ENCRYPTION_KEY).
    -- NULL until the operator initiates TOTP enrollment.
    "totpSecret"     TEXT,
    -- NULL until the operator completes TOTP enrollment (verified a valid
    -- code). After this is non-null, every operator mutation must pass
    -- a TOTP step-up against OperatorSession.totpVerifiedAt.
    "totpEnrolledAt" TIMESTAMPTZ,
    -- Soft-deletion. False keeps the audit trail readable even after the
    -- operator leaves the company.
    "isActive"       BOOLEAN      NOT NULL DEFAULT true,
    "lastLoginAt"    TIMESTAMPTZ,
    "lastTotpAt"     TIMESTAMPTZ,
    "createdAt"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "updatedAt"      TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Operator_email_key" ON "Operator" ("email");
CREATE INDEX        "Operator_isActive_idx" ON "Operator" ("isActive");

-- ── OperatorSession ────────────────────────────────────────────────────
-- Server-side session store. The session `id` IS the opaque session
-- token, returned to the operator as an httpOnly secure cookie.
-- Sessions have a 7-day absolute lifetime. Revoked sessions cannot be
-- reused.

CREATE TABLE "OperatorSession" (
    "id"             UUID         NOT NULL,
    "operatorId"     UUID         NOT NULL,
    -- Set when the operator passes TOTP step-up. Mutations check this.
    "totpVerifiedAt" TIMESTAMPTZ,
    "createdAt"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "lastUsedAt"     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "expiresAt"      TIMESTAMPTZ  NOT NULL,
    "ip"             TEXT,
    "userAgent"      TEXT,
    -- Soft-revoke. When non-null the session is dead even if not yet
    -- expired. Audited at the application layer.
    "revokedAt"      TIMESTAMPTZ,

    CONSTRAINT "OperatorSession_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OperatorSession"
    ADD CONSTRAINT "OperatorSession_operatorId_fkey"
    FOREIGN KEY ("operatorId") REFERENCES "Operator"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "OperatorSession_operatorId_idx" ON "OperatorSession" ("operatorId");
CREATE INDEX "OperatorSession_expiresAt_idx"  ON "OperatorSession" ("expiresAt");

-- ── OperatorRecoveryCode ───────────────────────────────────────────────
-- One-time recovery codes generated at TOTP enrollment. Stored as
-- argon2id hashes. Shown to the operator exactly once at enrollment
-- time; never retrievable afterwards. Each code can be consumed at
-- most once.

CREATE TABLE "OperatorRecoveryCode" (
    "id"         UUID         NOT NULL,
    "operatorId" UUID         NOT NULL,
    -- argon2id hash of the recovery code — never stored in plaintext.
    "codeHash"   TEXT         NOT NULL,
    -- NULL until consumed; set to the timestamp of use.
    "consumedAt" TIMESTAMPTZ,
    "createdAt"  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "OperatorRecoveryCode_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OperatorRecoveryCode"
    ADD CONSTRAINT "OperatorRecoveryCode_operatorId_fkey"
    FOREIGN KEY ("operatorId") REFERENCES "Operator"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "OperatorRecoveryCode_operatorId_idx" ON "OperatorRecoveryCode" ("operatorId");
