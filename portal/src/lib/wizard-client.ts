// =============================================================================
// KAIA-1164 — Client wizard GET / PATCH helpers.
//
// Read + write helpers for the client-facing wizard endpoints. The client
// calls GET /api/portal/wizard/[step] to load the current state, and PATCH
// the same route to save (status='draft') or submit (status='submitted') a
// new version.
//
//   - GET  returns the latest version AND the activeForBot version (they can
//     differ if a previous submission has been approved and the client has
//     since edited but not re-submitted).
//   - PATCH reads `data` (arbitrary JSON object), persists as a new row with
//     version = max(version) + 1, sets status to 'draft' (autosave) or
//     'submitted', and writes one ChatbotConfigStepAudit row.
//
// Per-step key allowlist is centralised here (not in the wizard code). When
// the per-step Zod schema registry lands (KAIA-1166, KAIA-1172 follow-up)
// this file is the only place that needs to be updated.
// =============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';

export type WizardStepStatus = 'draft' | 'submitted';

export const ALLOWED_WIZARD_STEP_KEYS: ReadonlySet<string> = new Set([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
]);

export const ALLOWED_WIZARD_STEP_KEY_LIST: readonly string[] = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
];

export interface WizardClientWriteRequest {
  stepKey: string;
  data: Record<string, unknown>;
  status: WizardStepStatus;
}

export type WizardClientErrorCode =
  | { code: 'invalid_step_key' }
  | { code: 'invalid_status' }
  | { code: 'invalid_data' };

export class WizardClientError extends Error {
  constructor(public readonly error: WizardClientErrorCode) {
    super(error.code);
    this.name = 'WizardClientError';
  }
}

function assertValidStepKey(stepKey: string): void {
  if (!ALLOWED_WIZARD_STEP_KEYS.has(stepKey)) {
    throw new WizardClientError({ code: 'invalid_step_key' });
  }
}

function assertValidStatus(status: string): WizardStepStatus {
  if (status !== 'draft' && status !== 'submitted') {
    throw new WizardClientError({ code: 'invalid_status' });
  }
  return status;
}

function assertValidData(data: unknown): Record<string, unknown> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new WizardClientError({ code: 'invalid_data' });
  }
  return data as Record<string, unknown>;
}

interface SaveContext {
  clientId: string;
  email: string;
  // WP-13 — required, no default: every call site must say which
  // product's wizard this step belongs to. See CHATBOT_PRODUCT_CODE in
  // wizard-catalog.ts for the constant every current caller passes.
  productCode: string;
}

export interface SaveResult {
  stepId: string;
  version: number;
  status: WizardStepStatus;
}

// WP-24 — optional actor override. Every existing caller (the wizard
// PATCH route) omits this and keeps getting actor: 'client' / actorId:
// ctx.email, exactly as before. The intake-seeding path (WP-24) is the
// first caller that isn't the client themselves — the audit trail should
// say so rather than claiming the client typed something they never saw.
export interface SaveWizardStepOptions {
  actor?: 'client' | 'operator' | 'system';
  actorId?: string | null;
  comment?: string | null;
}

export async function saveWizardStep(
  prisma: PrismaClient,
  ctx: SaveContext,
  req: WizardClientWriteRequest,
  options: SaveWizardStepOptions = {},
): Promise<SaveResult> {
  assertValidStepKey(req.stepKey);
  const status = assertValidStatus(req.status);
  const data = assertValidData(req.data);
  const actor = options.actor ?? 'client';
  const actorId = options.actor ? (options.actorId ?? null) : ctx.email;

  return prisma.$transaction(async (tx) => {
    const latest = await tx.chatbotConfigStep.findFirst({
      where: { clientId: ctx.clientId, productCode: ctx.productCode, stepKey: req.stepKey },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    // WP-09 — denormalize tenantId from the client onto every child row,
    // same as the Phase 0 backfill did for existing rows (see
    // src/lib/tenant.ts for why the client itself is always resolvable).
    const client = await tx.chatbotClient.findUnique({
      where: { id: ctx.clientId },
      select: { tenantId: true },
    });

    const created = await tx.chatbotConfigStep.create({
      data: {
        clientId: ctx.clientId,
        tenantId: client?.tenantId ?? null,
        productCode: ctx.productCode,
        stepKey: req.stepKey,
        version: nextVersion,
        status,
        payload: data as Prisma.InputJsonValue,
        submittedAt: status === 'submitted' ? new Date() : null,
      },
      select: { id: true, version: true, status: true },
    });

    await tx.chatbotConfigStepAudit.create({
      data: {
        stepId: created.id,
        tenantId: client?.tenantId ?? null,
        version: created.version,
        actor,
        actorId,
        action: status === 'submitted' ? 'submit' : 'edit',
        comment: options.comment ?? null,
      },
    });

    return {
      stepId: created.id,
      version: created.version,
      status: created.status as WizardStepStatus,
    };
  });
}

export interface WizardClientReadResult {
  latest: {
    id: string;
    version: number;
    status: string;
    payload: Prisma.JsonValue;
    submittedAt: Date | null;
    approvedAt: Date | null;
    activeForBot: boolean;
    createdAt: Date;
    updatedAt: Date;
    // WP-24 — true when this exact version's ChatbotConfigStepAudit row
    // was written with actor: 'system' (the intake-seeding job), not
    // typed in by the client. Once the client edits and re-saves, the
    // new version's own audit row is actor: 'client' and this flips
    // false — the marker only ever describes the version being shown.
    seededFromIntake: boolean;
  } | null;
  active: {
    id: string;
    version: number;
    status: string;
    payload: Prisma.JsonValue;
    activeForBot: true;
    submittedAt: Date | null;
    approvedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
}

export async function readWizardStep(
  prisma: PrismaClient,
  clientId: string,
  productCode: string,
  stepKey: string,
): Promise<WizardClientReadResult | null> {
  assertValidStepKey(stepKey);

  const [latest, active] = await Promise.all([
    prisma.chatbotConfigStep.findFirst({
      where: { clientId, productCode, stepKey },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        status: true,
        payload: true,
        submittedAt: true,
        approvedAt: true,
        activeForBot: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.chatbotConfigStep.findFirst({
      where: { clientId, productCode, stepKey, activeForBot: true },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        version: true,
        status: true,
        payload: true,
        submittedAt: true,
        approvedAt: true,
        activeForBot: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  if (!latest && !active) return null;

  let seededFromIntake = false;
  if (latest) {
    const creationAudit = await prisma.chatbotConfigStepAudit.findFirst({
      where: { stepId: latest.id, version: latest.version },
      orderBy: { createdAt: 'asc' },
      select: { actor: true },
    });
    seededFromIntake = creationAudit?.actor === 'system';
  }

  return {
    latest: latest ? { ...latest, seededFromIntake } : null,
    active: active as WizardClientReadResult['active'],
  };
}
