// =============================================================================
// KAIA-1106 — Operator tool-integration settings helpers.
//
// Every read/write to the OperatorSettings tables goes through this module.
// The audit table is append-only: the only Prisma operation exposed for
// OperatorSettingsAudit is `create`. No caller in API or worker code
// bypasses this module with raw `prisma.operatorSettingsAudit.*` calls.
//
// Related tickets:
//   API read/write:    KAIA-1084
//   Rotate worker:     KAIA-1083
//   Health probes:     KAIA-1085
//   Frontend:          KAIA-1086
//   Operator identity: KAIA-1082 (actorOperatorId FK target)
// =============================================================================

import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

export type AuditAction =
  | 'created'
  | 'updated'
  | 'rotation_requested'
  | 'rotation_succeeded'
  | 'rotation_failed'
  | 'health_status_changed'
  | 'deleted';

export type SettingsCategory =
  | 'email'
  | 'workflow'
  | 'database'
  | 'auth'
  | 'billing'
  | 'other';

export type HealthStatus =
  | 'healthy'
  | 'degraded'
  | 'failed'
  | 'unknown';

// ── Reads ─────────────────────────────────────────────────────────────────

export async function getOperatorSettings() {
  return prisma.operatorSettings.findMany({
    orderBy: { category: 'asc' },
  });
}

export async function getOperatorSettingsByKey(toolKey: string) {
  return prisma.operatorSettings.findUnique({
    where: { toolKey },
  });
}

export type OperatorSettingsRow = Awaited<ReturnType<typeof getOperatorSettingsByKey>>;

// ── Writes ────────────────────────────────────────────────────────────────

export async function createOperatorSettings(
  data: Prisma.OperatorSettingsCreateInput,
  audit: { actorEmail?: string | null; actorOperatorId?: string | null },
) {
  const row = await prisma.operatorSettings.create({ data });

  await appendAuditEntry({
    settingsId: row.id,
    action: 'created',
    after: row,
    actorEmail: audit.actorEmail ?? null,
    actorOperatorId: audit.actorOperatorId ?? null,
  });

  return row;
}

export async function updateOperatorSettings(
  toolKey: string,
  data: Prisma.OperatorSettingsUpdateInput,
  audit: { actorEmail?: string | null; actorOperatorId?: string | null },
) {
  const before = await prisma.operatorSettings.findUniqueOrThrow({
    where: { toolKey },
  });

  const row = await prisma.operatorSettings.update({
    where: { toolKey },
    data,
  });

  await appendAuditEntry({
    settingsId: row.id,
    action: 'updated',
    before,
    after: row,
    actorEmail: audit.actorEmail ?? null,
    actorOperatorId: audit.actorOperatorId ?? null,
  });

  return row;
}

export async function recordRotation(
  toolKey: string,
  status: 'rotation_succeeded' | 'rotation_failed',
  audit: { actorEmail?: string | null; actorOperatorId?: string | null },
) {
  const before = await prisma.operatorSettings.findUniqueOrThrow({
    where: { toolKey },
  });

  const data: Prisma.OperatorSettingsUpdateInput =
    status === 'rotation_succeeded'
      ? { lastRotatedAt: new Date() }
      : {};

  const row = await prisma.operatorSettings.update({
    where: { toolKey },
    data,
  });

  await appendAuditEntry({
    settingsId: row.id,
    action: status,
    before,
    after: row,
    actorEmail: audit.actorEmail ?? null,
    actorOperatorId: audit.actorOperatorId ?? null,
  });

  return row;
}

export async function recordHealthCheck(
  toolKey: string,
  status: HealthStatus,
  audit: { actorEmail?: string | null; actorOperatorId?: string | null },
) {
  const before = await prisma.operatorSettings.findUniqueOrThrow({
    where: { toolKey },
  });

  const row = await prisma.operatorSettings.update({
    where: { toolKey },
    data: {
      lastHealthCheckAt: new Date(),
      lastHealthStatus: status,
    },
  });

  await appendAuditEntry({
    settingsId: row.id,
    action: 'health_status_changed',
    before,
    after: row,
    actorEmail: audit.actorEmail ?? null,
    actorOperatorId: audit.actorOperatorId ?? null,
  });

  return row;
}

// ── Audit (append-only) ───────────────────────────────────────────────────

interface AppendAuditInput {
  settingsId: string;
  action: AuditAction;
  before?: object | null;
  after?: object | null;
  actorEmail?: string | null;
  actorOperatorId?: string | null;
}

async function appendAuditEntry(input: AppendAuditInput) {
  await prisma.operatorSettingsAudit.create({
    data: {
      settingsId: input.settingsId,
      action: input.action,
      before: input.before ?? Prisma.JsonNull,
      after: input.after ?? Prisma.JsonNull,
      actorEmail: input.actorEmail ?? null,
      actorOperatorId: input.actorOperatorId ?? null,
    },
  });
}

// ── Audit reads (for the audit log UI) ────────────────────────────────────

export async function getAuditLogForSettings(settingsId: string) {
  return prisma.operatorSettingsAudit.findMany({
    where: { settingsId },
    orderBy: { createdAt: 'desc' },
  });
}
