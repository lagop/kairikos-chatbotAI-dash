// =============================================================================
// KAIA-1166 — BE-4 service layer.
//
// Composes the pure visibility logic in `wizard-tier.ts` with Prisma reads:
//   * resolves the cliente's tier from `ChatbotClient.tier`;
//   * looks up the persisted (clientId, stepKey) row in `ChatbotConfigStep`;
//   * assembles the response shapes the route handlers serialise.
//
// No Next.js / no cookies / no Prisma transactions in here — just plain
// async functions over the shared `prisma` singleton. The route handlers
// own auth and response shaping; the unit tests own the visibility matrix.
// =============================================================================

import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { prisma } from './prisma';
import {
  normaliseTier,
  resolveClientStep,
  resolveOperatorStep,
  listStepsForClient,
  listStepsForOperator,
  type ClientStepListResponse,
  type ClientStepDataResponse,
  type OperatorStepListResponse,
  type OperatorStepDataResponse,
  type ResolvedClientStep,
  type ResolvedOperatorStep,
  type SavedStepRecord,
  type Tier,
  type WizardStepNumber,
} from './wizard-tier';

export interface ClientContext {
  clientId: string;
  /** Optional pre-resolved tier; if omitted, the service hits the DB. */
  tier?: Tier;
}

export interface OperatorContext {
  clientId: string;
  /** Optional pre-resolved tier; if omitted, the service hits the DB. */
  tier?: Tier;
}

export interface WizardTierError {
  code: 'client_not_found' | 'invalid_step_number';
}

export class WizardTierServiceError extends Error {
  constructor(public readonly error: WizardTierError) {
    super(error.code);
    this.name = 'WizardTierServiceError';
  }
}

async function readTier(db: PrismaClient, clientId: string): Promise<Tier> {
  const client = await db.chatbotClient.findUnique({
    where: { id: clientId },
    select: { tier: true },
  });
  if (!client) {
    throw new WizardTierServiceError({ code: 'client_not_found' });
  }
  return normaliseTier(client.tier);
}

async function readSavedStep(
  db: PrismaClient,
  clientId: string,
  stepNumber: WizardStepNumber,
): Promise<SavedStepRecord | null> {
  const stepKey = String(stepNumber);
  const row = await db.chatbotConfigStep.findFirst({
    where: { clientId, stepKey },
    orderBy: { version: 'desc' },
    select: { payload: true, status: true, version: true },
  });
  if (!row) return null;
  return {
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    status: row.status,
    version: row.version,
  };
}

function clientStepDataWith(
  data: ClientStepDataResponse,
  clientId: string,
): ClientStepDataResponse {
  return { ...data, clientId };
}

function operatorStepDataWith(
  data: OperatorStepDataResponse,
  clientId: string,
): OperatorStepDataResponse {
  return { ...data, clientId };
}

// =============================================================================
// Cliente-facing helpers.
// =============================================================================

export async function getClientWizardStepList(
  db: PrismaClient = prisma,
  ctx: ClientContext,
): Promise<ClientStepListResponse> {
  const tier = ctx.tier ?? (await readTier(db, ctx.clientId));
  return {
    clientId: ctx.clientId,
    tier,
    steps: listStepsForClient(tier),
  };
}

export async function getClientWizardStep(
  db: PrismaClient = prisma,
  ctx: ClientContext,
  stepNumber: number,
): Promise<ResolvedClientStep> {
  if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > 12) {
    return { kind: 'not_found' };
  }
  const tier = ctx.tier ?? (await readTier(db, ctx.clientId));
  const saved = await readSavedStep(db, ctx.clientId, stepNumber as WizardStepNumber);
  const resolved = resolveClientStep(stepNumber as WizardStepNumber, tier, saved);
  if (resolved.kind === 'not_found') return resolved;
  return {
    kind: resolved.kind,
    data: clientStepDataWith(resolved.data, ctx.clientId),
  };
}

// =============================================================================
// Operator-facing helpers.
// =============================================================================

export async function getOperatorWizardStepList(
  db: PrismaClient = prisma,
  ctx: OperatorContext,
): Promise<OperatorStepListResponse> {
  const tier = ctx.tier ?? (await readTier(db, ctx.clientId));
  return {
    clientId: ctx.clientId,
    tier,
    steps: listStepsForOperator(tier),
  };
}

export async function getOperatorWizardStep(
  db: PrismaClient = prisma,
  ctx: OperatorContext,
  stepNumber: number,
): Promise<ResolvedOperatorStep> {
  if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > 12) {
    return { kind: 'not_found' };
  }
  const tier = ctx.tier ?? (await readTier(db, ctx.clientId));
  const saved = await readSavedStep(db, ctx.clientId, stepNumber as WizardStepNumber);
  const resolved = resolveOperatorStep(stepNumber as WizardStepNumber, tier, saved);
  if (resolved.kind === 'not_found') return resolved;
  return {
    kind: 'found',
    data: operatorStepDataWith(resolved.data!, ctx.clientId),
  };
}
