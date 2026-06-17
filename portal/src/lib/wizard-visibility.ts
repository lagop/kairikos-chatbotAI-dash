// =============================================================================
// KAIA-1166 (BE-4) — Tier-aware visibility + payload resolvers.
//
// Pure helpers. No DB, no I/O. The route layer composes these with the
// Prisma read for `ChatbotConfigStep` and the session-derived `tier`.
//
// Two views:
//
//   • Cliente view (`listStepsForClient` / `resolveClientStep`):
//       - Steps 3 and 7 hidden for Starter, swapped for catalog defaults.
//       - Step 12 hidden for every tier (deferred to v1.1).
//       - The cliente sees `effectivePayload` and `autoConfigured` so the
//         frontend can show "configurado automáticamente para tu plan"
//         for hidden steps and render the bot-ready payload directly.
//
//   • Operator view (`listStepsForOperator` / `resolveOperatorStep`):
//       - Tier ignored. Operator always sees all 11 + the 12 label.
//       - Operator receives `savedPayload` (the actual cliente submission)
//         and `defaultPayload` (the catalog default) so they can audit
//         what the bot is *actually* running on vs. the catalog baseline.
//       - Step 12 is rendered with `editable: false` (v1.1 deferred) but
//         still in the list with `visible: true`.
//
// The contract is intentionally serializable: every function returns a
// plain object, so the route layer can `JSON.stringify` it without
// further mapping.
// =============================================================================

import {
  WIZARD_STEP_CATALOG,
  WIZARD_STEP_NUMBERS,
  WIZARD_VISIBLE_STEP_NUMBERS,
  type WizardStepNumber,
  type WizardStepDefinition,
  type WizardTier,
} from './wizard-catalog';

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

/** Lightweight per-step summary used in the step-list endpoints. */
export interface WizardStepListEntry {
  number: WizardStepNumber;
  key: string;
  label: string;
  block: WizardStepDefinition['block'];
  requiredForReady: boolean;
  /** Whether the step is visible to the requesting view (cliente/operator). */
  visible: boolean;
  /** Whether the cliente is currently running on the catalog default
   *  instead of a saved submission. False until the cliente saves a
   *  submission on this step. */
  autoConfigured: boolean;
  /** True only for Step 12 in v1. Frontend uses this to render the
   *  "Próximamente" label without hiding the row. */
  v11Deferred: boolean;
}

export interface WizardSavedState {
  hasSavedVersion: boolean;
  /** The latest step's status if any. */
  status?: string | undefined;
  /** ISO timestamp of the most recent submitted version. */
  submittedAt?: string | null;
  /** ISO timestamp of the most recent approved version. */
  approvedAt?: string | null;
  /** true when the latest approved version has `activeForBot = true`. */
  activeForBot?: boolean | undefined;
}

export interface ClienteStepListResponse {
  clientTier: WizardTier | null;
  steps: WizardStepListEntry[];
}

export interface OperatorStepListResponse {
  clientId: string;
  clientTier: WizardTier | null;
  steps: WizardStepListEntry[];
}

/** Detail view (one step). */
export interface ClienteStepDataResponse {
  number: WizardStepNumber;
  key: string;
  label: string;
  block: WizardStepDefinition['block'];
  /** Catalog tier-visibility. False means the step is hidden for the
   *  cliente's tier; `effectivePayload` will be the catalog default. */
  visibleForTier: boolean;
  /** True when the step is hidden for the cliente's tier (server fell
   *  back to the catalog default). */
  autoConfigured: boolean;
  /** What the bot should run on. Equals the saved payload when the
   *  cliente has saved data, otherwise the catalog default. */
  effectivePayload: Record<string, unknown> | null;
  /** The actual cliente submission if any (may be null). Surfaced so the
   *  frontend can show "Tienes X configurado" even when the tier hides
   *  the step. */
  savedPayload: Record<string, unknown> | null;
  /** Catalog baseline, always present. */
  defaultPayload: Record<string, unknown>;
  saved: WizardSavedState;
  v11Deferred: boolean;
}

export interface OperatorStepDataResponse {
  number: WizardStepNumber;
  key: string;
  label: string;
  block: WizardStepDefinition['block'];
  /** Always true in operator view (per spec). */
  visibleForTier: true;
  /** True when the cliente currently sees the catalog default (i.e.
   *  hidden for their tier). The operator can use this as a quick
   *  "is the cliente on the Starter safety rails?" indicator. */
  autoConfigured: boolean;
  /** What the bot is running on (cliente submission if any, else
   *  catalog default). */
  effectivePayload: Record<string, unknown> | null;
  /** The cliente's actual submission. Null when none yet. */
  savedPayload: Record<string, unknown> | null;
  /** Catalog baseline. */
  defaultPayload: Record<string, unknown>;
  /** Tier-visibility flag for the cliente. Lets the operator see
   *  "this cliente's tier hides Step 3" without leaving the page. */
  clienteVisibleForTier: boolean;
  /** Step 12 in v1 is non-editable for the operator (v1.1 deferred). */
  editable: boolean;
  v11Deferred: boolean;
  clientTier: WizardTier | null;
  saved: WizardSavedState;
}

// ---------------------------------------------------------------------------
// List views
// ---------------------------------------------------------------------------

/**
 * Cliente-facing step list. Tier-filtered.
 * `savedPerStep` is a Map<stepKey, WizardSavedState> the caller populates
 * from Prisma; the helper only consumes it.
 */
export function listStepsForClient(
  tier: WizardTier | null,
  savedPerStep: ReadonlyMap<string, WizardSavedState>,
): ClienteStepListResponse {
  const steps: WizardStepListEntry[] = WIZARD_STEP_NUMBERS.map((n) => {
    const def = WIZARD_STEP_CATALOG[n];
    const visible = def.visibleFor(tier);
    const saved = savedPerStep.get(def.key);
    return {
      number: n,
      key: def.key,
      label: def.label,
      block: def.block,
      requiredForReady: def.requiredForReady,
      visible,
      // Auto-configured = hidden for the tier OR (visible AND no saved
      // data — the bot will run on the catalog default for now).
      autoConfigured: !visible || !(saved?.hasSavedVersion ?? false),
      v11Deferred: def.v11Deferred,
    };
  });
  return { clientTier: tier, steps };
}

/**
 * Operator-facing step list. Tier-agnostic; always 11 + the 12 label.
 */
export function listStepsForOperator(
  clientId: string,
  clientTier: WizardTier | null,
  savedPerStep: ReadonlyMap<string, WizardSavedState>,
): OperatorStepListResponse {
  const steps: WizardStepListEntry[] = WIZARD_STEP_NUMBERS.map((n) => {
    const def = WIZARD_STEP_CATALOG[n];
    const visible = def.visibleFor(clientTier);
    const saved = savedPerStep.get(def.key);
    return {
      number: n,
      key: def.key,
      label: def.label,
      block: def.block,
      requiredForReady: def.requiredForReady,
      // Operator view: visible for every step regardless of tier, but
      // we keep `v11Deferred` so the frontend knows to render the
      // "Próximamente" label on Step 12.
      visible: true,
      // Operator's "autoConfigured" surfaces the cliente-side reality:
      //   true  → cliente's tier is hiding the step, OR the cliente has
      //           not saved any data on this step (bot runs on defaults)
      //   false → cliente's tier shows the step AND the cliente has
      //           saved data
      autoConfigured: !visible || !(saved?.hasSavedVersion ?? false),
      v11Deferred: def.v11Deferred,
    };
  });
  return { clientId, clientTier, steps };
}

// ---------------------------------------------------------------------------
// Detail views
// ---------------------------------------------------------------------------

/**
 * Resolve a single step for the cliente view. When the step is hidden for
 * the tier, the `effectivePayload` is the catalog default regardless of
 * what the cliente might have saved (the cliente can't actually save a
 * hidden step — the frontend hides the form — but the safety net here
 * means a tampered PATCH that bypasses the visibility check still gets
 * the right effective payload).
 */
export function resolveClientStep(
  n: WizardStepNumber,
  tier: WizardTier | null,
  saved: WizardSavedState,
  savedPayload: Record<string, unknown> | null,
): ClienteStepDataResponse {
  const def = WIZARD_STEP_CATALOG[n];
  const visibleForTier = def.visibleFor(tier);
  const hasSaved = saved.hasSavedVersion;
  const effectivePayload: Record<string, unknown> = visibleForTier && hasSaved && savedPayload
    ? savedPayload
    : { ...def.defaultPayload };
  return {
    number: n,
    key: def.key,
    label: def.label,
    block: def.block,
    visibleForTier,
    autoConfigured: !visibleForTier || !hasSaved,
    effectivePayload,
    savedPayload: savedPayload ?? null,
    defaultPayload: { ...def.defaultPayload },
    saved,
    v11Deferred: def.v11Deferred,
  };
}

/**
 * Resolve a single step for the operator view. Tier ignored.
 * `effectivePayload` is the saved submission if any, otherwise the catalog
 * default — this is what the bot is running on.
 */
export function resolveOperatorStep(
  n: WizardStepNumber,
  clientId: string,
  clientTier: WizardTier | null,
  saved: WizardSavedState,
  savedPayload: Record<string, unknown> | null,
): OperatorStepDataResponse {
  const def = WIZARD_STEP_CATALOG[n];
  const clienteVisibleForTier = def.visibleFor(clientTier);
  const hasSaved = saved.hasSavedVersion;
  const effectivePayload: Record<string, unknown> = hasSaved && savedPayload
    ? savedPayload
    : { ...def.defaultPayload };
  return {
    number: n,
    key: def.key,
    label: def.label,
    block: def.block,
    visibleForTier: true,
    autoConfigured: !clienteVisibleForTier || !hasSaved,
    effectivePayload,
    savedPayload: savedPayload ?? null,
    defaultPayload: { ...def.defaultPayload },
    clienteVisibleForTier,
    editable: !def.v11Deferred,
    v11Deferred: def.v11Deferred,
    clientTier,
    saved,
  };
}

// ---------------------------------------------------------------------------
// Helpers for the route layer
// ---------------------------------------------------------------------------

/**
 * Build a `Map<stepKey, WizardSavedState>` from a list of
 * `{ stepKey, latest }` rows the route layer pulls from Prisma. The
 * helper tolerates an empty list (cold start, no submissions yet).
 */
export function buildSavedStateMap(
  rows: ReadonlyArray<{ stepKey: string; latest: WizardSavedRow | null }>,
): Map<string, WizardSavedState> {
  const map = new Map<string, WizardSavedState>();
  for (const { stepKey, latest } of rows) {
    if (!latest) {
      map.set(stepKey, { hasSavedVersion: false });
      continue;
    }
    map.set(stepKey, {
      hasSavedVersion: true,
      status: latest.status,
      submittedAt: latest.submittedAt,
      approvedAt: latest.approvedAt,
      activeForBot: latest.activeForBot,
    });
  }
  return map;
}

export interface WizardSavedRow {
  status: string;
  submittedAt: string | null;
  approvedAt: string | null;
  activeForBot: boolean;
}

/**
 * Re-export the visible-step-number set so the route layer doesn't have
 * to import the catalog directly.
 */
export const VISIBLE_STEP_NUMBERS_FOR_CLIENTE: ReadonlySet<WizardStepNumber> = new Set(
  WIZARD_VISIBLE_STEP_NUMBERS,
);
