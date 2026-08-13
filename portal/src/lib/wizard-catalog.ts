// =============================================================================
// KAIA-1166 (BE-4) — Wizard step catalog (v1, source of truth).
//
// One row per v1 step (1..12). Steps 1-10 + 11 (Pruebas) ship in v1.
// Step 12 (Integraciones) is deferred to v1.1 (KAIA-1108) and is **not
// constructed** in v1: it exists in the catalog so the operator view can
// render the "Próximamente" label and the cliente view can hide it
// uniformly across all tiers.
//
// Tier visibility rule (per `spec-wizard-chatbot.md` v0.2 §"Visibilidad por
// tier", addenda CEO #1):
//
//   • Starter: Step 3 (Servicios y tarifas) and Step 7 (Derivación) hidden,
//     the server returns the catalog `defaultPayload` instead.
//   • Pro / Premium: see every step except Step 12.
//   • Step 12: hidden in cliente view for every tier in v1 (deferred to
//     v1.1 regardless of tier — see KAIA-1108 + the umbrella v1.1).
//   • Operator view: ignores tier. Always renders 11 + the 12 label
//     (visible: true, editable: false for Step 12).
//
// Status lifecycle for saved steps (independent of this file) lives in
// `wizard-client.ts` + `wizard-review.ts`; the catalog only owns the
// static description + tier visibility + default payload.
//
// This file is a pure module (no I/O, no Prisma). Frozen with Object.freeze
// so callers can rely on the catalog being immutable at runtime.
// =============================================================================

import type { Prisma } from '@prisma/client';

// WP-13 — this catalog is entirely chatbot-shaped (a single fixed 12-step
// list, no per-product variation). Every current wizard route/page passes
// this constant as the `productCode` now required by wizard-client.ts /
// wizard-tier-prisma.ts / wizard-review.ts — there is no multi-product
// wizard routing yet (that's WP-16). When it lands, call sites resolve a
// real productCode instead of importing this constant.
export const CHATBOT_PRODUCT_CODE = 'chatbot';

export type WizardTier = 'starter' | 'pro' | 'premium';
export type WizardBlock = 'identidad' | 'comportamiento' | 'activacion';
export type WizardStepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface WizardStepDefinition {
  /** Step number as it appears in the spec (1..12). The URL stepKey uses
   *  the same value, encoded as a string. */
  readonly number: WizardStepNumber;
  /** URL-safe string identifier. Matches the stepKey column on
   *  ChatbotConfigStep. Currently the number itself, kept as a string for
   *  forward compat (a future renaming would only touch the URL, not the
   *  data column). */
  readonly key: string;
  /** Human-readable label (Spanish; spec commit). */
  readonly label: string;
  /** High-level block the step belongs to (drives the 3-block progress bar). */
  readonly block: WizardBlock;
  /** Whether the step is required for the cliente to reach `ready`. Drives
   *  the `config_complete` trigger. */
  readonly requiredForReady: boolean;
  /** Whether the step is deferred to v1.1 (Step 12). When true, the cliente
   *  view hides it for every tier and the operator view renders the
   *  "Próximamente" label. */
  readonly v11Deferred: boolean;
  /** Tier visibility predicate. Step 12 returns `() => false` for every
   *  tier. Steps 3 and 7 return false only for `starter`. */
  readonly visibleFor: (tier: WizardTier | null) => boolean;
  /** Server-side default payload applied when the step is hidden for the
   *  cliente's tier (or when the operator has not yet captured any data
   *  and the bot is being constructed cold-start). The shape mirrors what
   *  the cliente would have entered. */
  readonly defaultPayload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Per-tier visibility predicates
//
// `visibleFor(tier)` returns true when the step is visible to a cliente
// on that tier. null tier is treated as "starter" (the DB default) so
// the safety rails kick in by default.
// ---------------------------------------------------------------------------

const visibleForAllTiers = (_tier: WizardTier | null): boolean => true;
const visibleForStarterAndAbove = (tier: WizardTier | null): boolean =>
  tier !== 'starter' && tier !== null;
const hiddenForEveryTier = (_tier: WizardTier | null): boolean => false;

// ---------------------------------------------------------------------------
// Default payloads (per spec §"Visibilidad por tier")
// ---------------------------------------------------------------------------

const STEP_3_DEFAULT_PAYLOAD: Record<string, unknown> = {
  servicios: [],
  // `precio_tipo` is the global default applied when a cliente with a
  // hidden Step 3 asks about pricing. The spec calls for `consultar` so
  // the bot always routes pricing queries to a human.
  precio_tipo: 'consultar',
};

const STEP_7_DEFAULT_PAYLOAD: Record<string, unknown> = {
  reglas: [],
  fallback_sin_respuesta: 'derivar',
};

// Steps 1, 2, 4, 5, 6, 8, 9, 10, 11 — no tier-driven defaults. The cliente
// owns the payload; null/undefined is the right cold-start state.
const NO_DEFAULT: Record<string, unknown> = {};

// Step 12 has no payload in v1 (deferred to v1.1).
const STEP_12_DEFAULT_PAYLOAD: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const WIZARD_STEP_CATALOG: Readonly<Record<WizardStepNumber, WizardStepDefinition>> =
  Object.freeze({
    1: {
      number: 1,
      key: '1',
      label: 'Perfil del negocio',
      block: 'identidad',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
    },
    2: {
      number: 2,
      key: '2',
      label: 'Personalidad y límites',
      block: 'identidad',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
    },
    3: {
      number: 3,
      key: '3',
      label: 'Servicios y tarifas',
      block: 'identidad',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForStarterAndAbove,
      defaultPayload: STEP_3_DEFAULT_PAYLOAD,
    },
    4: {
      number: 4,
      key: '4',
      label: 'FAQ',
      block: 'identidad',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
    },
    5: {
      number: 5,
      key: '5',
      label: 'Horario',
      block: 'comportamiento',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
    },
    6: {
      number: 6,
      key: '6',
      label: 'Captación de leads',
      block: 'comportamiento',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
    },
    7: {
      number: 7,
      key: '7',
      label: 'Derivación',
      block: 'comportamiento',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForStarterAndAbove,
      defaultPayload: STEP_7_DEFAULT_PAYLOAD,
    },
    8: {
      number: 8,
      key: '8',
      label: 'Canales',
      block: 'comportamiento',
      requiredForReady: false,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
    },
    9: {
      number: 9,
      key: '9',
      label: 'Mensajes',
      block: 'comportamiento',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
    },
    10: {
      number: 10,
      key: '10',
      label: 'Cumplimiento',
      block: 'activacion',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
    },
    11: {
      number: 11,
      key: '11',
      label: 'Pruebas',
      block: 'activacion',
      requiredForReady: true,
      v11Deferred: false,
      visibleFor: visibleForAllTiers,
      defaultPayload: NO_DEFAULT,
    },
    12: {
      number: 12,
      key: '12',
      label: 'Integraciones (Próximamente · v1.1)',
      block: 'activacion',
      requiredForReady: false,
      v11Deferred: true,
      visibleFor: hiddenForEveryTier,
      defaultPayload: STEP_12_DEFAULT_PAYLOAD,
    },
  });

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
