// =============================================================================
// DEPRECATED (WP-15) — this file used to be the wizard's only catalog. It
// is now a compatibility shim over the real source of truth,
// src/lib/catalogs/ — a registry of ONE catalog per Kairikos product, not
// just chatbot's. Every export here still works exactly as before (same
// values, same shapes) so the ~15 existing importers don't need to change
// in this commit; new code should import from '@/lib/catalogs' directly.
//
// Why keep it: "WIZARD_STEP_CATALOG se mantiene como alias obsoleto
// durante una versión para no romper importaciones en el mismo commit"
// (WP-15 AC). Every symbol here, not just WIZARD_STEP_CATALOG, gets the
// same treatment — splitting "some old imports still work, some don't"
// across one commit is a worse migration than keeping the whole shim.
// =============================================================================

import type { Prisma } from '@prisma/client';
import { CHATBOT_STEPS } from './catalogs/chatbot';
import type {
  WizardTier,
  WizardBlock,
  WizardStepNumber,
  WizardStepDefinition,
} from './catalogs/types';

export type { WizardTier, WizardBlock, WizardStepNumber, WizardStepDefinition };

// WP-13 — this catalog is entirely chatbot-shaped (a single fixed 12-step
// list, no per-product variation). Every current wizard route/page passes
// this constant as the `productCode` now required by wizard-client.ts /
// wizard-tier-prisma.ts / wizard-review.ts — there is no multi-product
// wizard routing yet (that's WP-16). When it lands, call sites resolve a
// real productCode instead of importing this constant.
export const CHATBOT_PRODUCT_CODE = 'chatbot';

export const WIZARD_STEP_CATALOG: Readonly<Record<WizardStepNumber, WizardStepDefinition>> =
  CHATBOT_STEPS;

export const WIZARD_STEP_NUMBERS: readonly WizardStepNumber[] = Object.freeze([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
]);

export const WIZARD_STEP_KEYS: ReadonlySet<string> = new Set(
  WIZARD_STEP_NUMBERS.map((n) => String(n)),
);

export const WIZARD_VISIBLE_STEP_NUMBERS: readonly WizardStepNumber[] = Object.freeze(
  WIZARD_STEP_NUMBERS.filter((n) => !WIZARD_STEP_CATALOG[n].v11Deferred),
);

export const WIZARD_REQUIRED_STEP_NUMBERS: readonly WizardStepNumber[] = Object.freeze(
  WIZARD_STEP_NUMBERS.filter((n) => WIZARD_STEP_CATALOG[n].requiredForReady),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a step number from a string (URL stepKey). Throws an Error with
 * a stable code when the input is not a valid step number; the route layer
 * maps this to a 400. Pure — no I/O.
 */
export function parseStepNumber(raw: string): WizardStepNumber {
  if (!/^(1[0-2]|[1-9])$/.test(raw)) {
    throw new WizardCatalogError({ code: 'invalid_step_number', value: raw });
  }
  const n = Number(raw) as WizardStepNumber;
  if (!WIZARD_STEP_CATALOG[n]) {
    throw new WizardCatalogError({ code: 'invalid_step_number', value: raw });
  }
  return n;
}

export function getStepDefinition(n: WizardStepNumber): WizardStepDefinition {
  const def = WIZARD_STEP_CATALOG[n];
  if (!def) {
    throw new WizardCatalogError({ code: 'invalid_step_number', value: String(n) });
  }
  return def;
}

/**
 * Normalize a tier value coming from the database / session. The
 * `ChatbotClient.tier` column is a free-form string today; we treat
 * anything outside {starter, pro, premium} as `null` so the visibility
 * predicate can decide what to do. Default (`null`) is `starter` per
 * the spec's tierless behavior.
 */
export function normalizeTier(raw: string | null | undefined): WizardTier | null {
  if (raw === 'starter' || raw === 'pro' || raw === 'premium') return raw;
  return null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type WizardCatalogErrorCode = { code: 'invalid_step_number'; value: string };

export class WizardCatalogError extends Error {
  constructor(public readonly error: WizardCatalogErrorCode) {
    super(error.code);
    this.name = 'WizardCatalogError';
  }
}

// Re-export Prisma's Json type for callers that want a typed payload alias.
export type WizardJsonPayload = Prisma.JsonValue;
