// =============================================================================
// KAIA-1166 (BE-4) — Prisma-backed read helpers for the tier-aware wizard.
//
// The route layer composes these with the pure visibility/resolve helpers
// in `wizard-visibility.ts`. The Prisma calls live here so the routes
// stay thin and unit tests can mock the persistence boundary cleanly.
//
// All functions take an explicit `prisma: PrismaClient` (no global import)
// so they're trivially testable with the same mock pattern as
// `wizard-client.ts` / `wizard-review.ts`.
// =============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';
import { normalizeTier, type WizardTier } from './wizard-catalog';
import type { WizardSavedRow, WizardSavedState } from './wizard-visibility';

// ---------------------------------------------------------------------------
// Client lookup
// ---------------------------------------------------------------------------

export interface ResolvedClientTier {
  clientId: string;
  email: string;
  tier: WizardTier | null;
  /** Free-form tier string from the DB. Surfaced for the operator view
   *  so it doesn't lose the raw value (in case of legacy data with
   *  unexpected values). */
  rawTier: string;
}

/**
 * Resolve a client + tier from a `clientId`. Returns null when the
 * client doesn't exist. The caller is responsible for the auth check
 * (route layer).
 *
 * WP-13 — deliberately has no `productCode` parameter: it only reads
 * `ChatbotClient` (tier is a client-level billing attribute, not a
 * per-product one) and never touches `ChatbotConfigStep`. Forcing a
 * product code through here would be ceremony with no behavior behind
 * it — see `jsonToObject` below for the same reasoning.
 */
export async function resolveClientTier(
  prisma: PrismaClient,
  clientId: string,
): Promise<ResolvedClientTier | null> {
  const client = await prisma.chatbotClient.findUnique({
    where: { id: clientId },
    select: { id: true, email: true, tier: true },
  });
  if (!client) return null;
  return {
    clientId: client.id,
    email: client.email,
    tier: normalizeTier(client.tier),
    rawTier: client.tier,
  };
}

// ---------------------------------------------------------------------------
// Saved-step summary reads
// ---------------------------------------------------------------------------

/**
 * Read the latest version of every wizard step for a client. The query
 * uses `findMany` with `orderBy: [{ stepKey: 'asc' }, { version: 'desc' }]`
 * and the route layer reduces it to a `Map<stepKey, WizardSavedState>`.
 *
 * We use a small `take: 200` cap as a safety belt for malformed
 * stepKey rows in the DB (Prisma will return at most one row per
 * (stepKey, version) due to the unique constraint, but this caps
 * blast radius on a misconfigured dataset).
 */
export interface SavedStepRow {
  stepKey: string;
  latest: {
    status: string;
    submittedAt: Date | null;
    approvedAt: Date | null;
    activeForBot: boolean;
  } | null;
}

export async function readLatestStepsForClient(
  prisma: PrismaClient,
  clientId: string,
  productCode: string,
): Promise<SavedStepRow[]> {
  // Pull every row for the client + product and reduce in app code. The
  // volume is bounded by `version` count per step; in the happy path
  // this is ~12 rows (one per step). We do not use `groupBy` because the
  // columns we need aren't aggregate-friendly in a single Prisma call.
  const rows = await prisma.chatbotConfigStep.findMany({
    where: { clientId, productCode },
    orderBy: [{ stepKey: 'asc' }, { version: 'desc' }],
    select: {
      stepKey: true,
      version: true,
      status: true,
      submittedAt: true,
      approvedAt: true,
      activeForBot: true,
    },
    take: 200,
  });

  // Reduce to one row per stepKey (the first one, which is the highest
  // version because of the orderBy).
  const latestByStep = new Map<string, SavedStepRow>();
  for (const row of rows) {
    if (latestByStep.has(row.stepKey)) continue;
    latestByStep.set(row.stepKey, {
      stepKey: row.stepKey,
      latest: {
        status: row.status,
        submittedAt: row.submittedAt,
        approvedAt: row.approvedAt,
        activeForBot: row.activeForBot,
      },
    });
  }
  return Array.from(latestByStep.values());
}

/**
 * Like `readLatestStepsForClient` but only for a single stepKey. Used by
 * the per-step GET routes. Returns null when no row exists yet.
 */
export async function readLatestStepForClient(
  prisma: PrismaClient,
  clientId: string,
  productCode: string,
  stepKey: string,
): Promise<{ latest: SavedStepRow['latest']; payload: Prisma.JsonValue | null } | null> {
  const row = await prisma.chatbotConfigStep.findFirst({
    where: { clientId, productCode, stepKey },
    orderBy: { version: 'desc' },
    select: {
      status: true,
      submittedAt: true,
      approvedAt: true,
      activeForBot: true,
      payload: true,
    },
  });
  if (!row) return null;
  return {
    latest: {
      status: row.status,
      submittedAt: row.submittedAt,
      approvedAt: row.approvedAt,
      activeForBot: row.activeForBot,
    },
    payload: row.payload,
  };
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/**
 * Narrow a Prisma `JsonValue` to a plain object payload, or null when the
 * value is null / not an object (the cliente wizard only ever stores
 * JSON objects; the schema doesn't enforce it, so we narrow defensively).
 *
 * WP-13 — no `productCode` parameter: this is a pure value transform, no
 * Prisma access at all. See the note on `resolveClientTier` above.
 */
export function jsonToObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
