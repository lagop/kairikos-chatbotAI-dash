-- CreateTable: OperatorSettings + OperatorSettingsAudit (KAIA-1106)
--
-- OperatorSettings: one row per external tool/service the operator portal
-- integrates with (Resend, n8n, Supabase, Stripe, etc.). Stores the
-- *reference* to where the secret lives in 1Password and operational
-- metadata (last rotation, health status) but NEVER the secret value itself.
--
-- OperatorSettingsAudit: append-only audit log for every change to
-- OperatorSettings. Enforced at the application layer — the helper module
-- in src/lib/operator-settings.ts only exposes Prisma `create`.
--
-- The `actorOperatorId` FK references a future Operator identity model
-- (KAIA-1082). It is nullable until KAIA-1082 lands; after that the column
-- becomes required.
--
-- Rollback safety: neither table has production dependencies yet. Safe to
-- revert before the /api/admin/portal/settings route (KAIA-1084) ships.

-- ── OperatorSettings ────────────────────────────────────────────────────

CREATE TABLE "OperatorSettings" (
    "id"                   UUID         NOT NULL,
    -- Stable tool key used in code and API routes (e.g. 'resend', 'n8n').
    "toolKey"              TEXT         NOT NULL,
    -- Human label shown in the UI (e.g. "Resend", "n8n", "Supabase").
    "displayName"          TEXT         NOT NULL,
    -- Dashboard grouping category: 'email' | 'workflow' | 'database' |
    -- 'auth' | 'billing' | 'other'.
    "category"             TEXT         NOT NULL,
    -- Env var holding the secret (nullable — some tools don't use one).
    "envVarName"           TEXT,
    -- 1Password reference: op://Vault/Item/Field. Never the actual secret.
    "secretManagerRef"     TEXT         NOT NULL,
    -- Last successful rotation (set by KAIA-1083 rotate worker).
    "lastRotatedAt"        TIMESTAMPTZ,
    -- Last health-check timestamp (set by KAIA-1085 health probe worker).
    "lastHealthCheckAt"    TIMESTAMPTZ,
    -- Health status: 'healthy' | 'degraded' | 'failed' | 'unknown'.
    "lastHealthStatus"     TEXT         NOT NULL DEFAULT 'unknown',
    -- Days before rotation reminder badge appears.
    "rotationReminderDays" INTEGER      NOT NULL DEFAULT 90,
    -- Free-text operator notes.
    "notes"                TEXT,
    "createdAt"            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    "updatedAt"            TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "OperatorSettings_pkey" PRIMARY KEY ("id")
);

-- Lookup by tool key (used by the getOperatorSettingsByKey helper).
CREATE UNIQUE INDEX "OperatorSettings_toolKey_key"
    ON "OperatorSettings" ("toolKey");

-- Dashboard filter by category.
CREATE INDEX "OperatorSettings_category_idx"
    ON "OperatorSettings" ("category");

-- Dashboard filter by health status + last check time.
CREATE INDEX "OperatorSettings_lastHealthStatus_lastHealthCheckAt_idx"
    ON "OperatorSettings" ("lastHealthStatus", "lastHealthCheckAt");

-- ── OperatorSettingsAudit ───────────────────────────────────────────────

CREATE TABLE "OperatorSettingsAudit" (
    "id"               UUID         NOT NULL,
    "settingsId"       UUID         NOT NULL,
    -- FK to Operator identity (KAIA-1082). Nullable until that lands.
    "actorOperatorId"  UUID,
    -- Denormalized operator email at write time.
    "actorEmail"       TEXT,
    -- Event type: 'created' | 'updated' | 'rotation_requested' |
    -- 'rotation_succeeded' | 'rotation_failed' | 'health_status_changed' |
    -- 'deleted'.
    "action"           TEXT         NOT NULL,
    -- Row snapshot before change (JSON, omit secret values).
    "before"           JSONB,
    -- Row snapshot after change (JSON).
    "after"            JSONB,
    -- Free-form metadata (request_id, user_agent, IP, etc.).
    "metadata"         JSONB,
    "createdAt"        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT "OperatorSettingsAudit_pkey" PRIMARY KEY ("id")
);

-- FK: audit rows cascade-deleted when the parent settings row is removed.
ALTER TABLE "OperatorSettingsAudit"
    ADD CONSTRAINT "OperatorSettingsAudit_settingsId_fkey"
    FOREIGN KEY ("settingsId") REFERENCES "OperatorSettings"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Lookup: all audit entries for a given settings row.
CREATE INDEX "OperatorSettingsAudit_settingsId_idx"
    ON "OperatorSettingsAudit" ("settingsId");

-- Filter by event type (e.g. all rotation_failed events).
CREATE INDEX "OperatorSettingsAudit_action_idx"
    ON "OperatorSettingsAudit" ("action");

-- Timeline queries across all settings.
CREATE INDEX "OperatorSettingsAudit_createdAt_idx"
    ON "OperatorSettingsAudit" ("createdAt");
