// =============================================================================
// KAIA-1166 — BE-4: Tier-aware step visibility logic + server-side defaults.
//
// Pure functions (no DB, no Next.js). The cliente view is filtered by the
// authenticated client's `tier`; the operator view always shows every step.
// Step 12 (Integraciones) is hidden in v1 regardless of tier — it is part of
// the v1.1 credentials-vault surface (umbrella [KAIA-1108]) and is not built
// in v1.
//
// The catalog is the single source of truth. Adding or renaming a step is
// a one-line change here. Frozen with `Object.freeze` to catch accidental
// mutation during dev.
//
// Tier semantics
//   starter  : 11 visible steps (1-11). Steps 3 (servicios) and 7
//              (derivación) are HIDDEN — the bot runs on the default payload
//              the server returns, the cliente never sees those forms.
//   pro      : all 11 visible (1-11).
//   premium  : all 11 visible (1-11).
//
// Step 12 (Integraciones) is reserved for v1.1 and is hidden for every
// tier in v1. The operator view ignores the tier gate and always shows
// the full 12-entry list, with `visible: true, autoConfigured: false` —
// the operator needs to see Step 12 to know it exists for the future
// plan.
//
// When a step is hidden for a cliente, the server returns the catalog's
// `defaultPayload` as `effectivePayload` and sets `autoConfigured: true`.
// When the cliente has saved a draft/submitted version of a hidden step
// the saved payload is still surfaced as `savedPayload` for the operator
// audit view, but the cliente's bot runs on the default. Once the cliente
// upgrades tier the saved payload becomes live on next bot load.
// =============================================================================

export const WIZARD_STEP_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type WizardStepNumber = (typeof WIZARD_STEP_NUMBERS)[number];

/**
 * Canonical Chatbot tier names. Mirrors the `ChatbotTier` union in
 * src/types/portal.ts. The Prisma column is a free-form `String` so we
 * normalise on read.
 */
export type Tier = 'starter' | 'pro' | 'premium';

/**
 * Tiers that gate the wizard surface in v1. New tiers must be added here
 * explicitly — the default branch in `isVisibleForTier` returns `true`
 * for known tiers and `false` for unknown ones.
 */
export const KNOWN_TIERS: readonly Tier[] = ['starter', 'pro', 'premium'] as const;

export function normaliseTier(raw: string | null | undefined): Tier {
  if (raw === 'starter' || raw === 'pro' || raw === 'premium') return raw;
  return 'starter';
}

export interface WizardStepCatalogEntry {
  /** 1..12 — the v1 step ordering. */
  number: WizardStepNumber;
  /**
   * Stable string key used in the persisted ChatbotConfigStep.stepKey
   * column. Equals the string form of `number` in v1.
   */
  key: string;
  /** Display label, kira voice. */
  label: string;
  /** Top-level block in the wizard UI: 'setup' | 'services' | 'review'. */
  block: 'setup' | 'services' | 'review';
  /** Tiers for which the cliente view renders this step. */
  visibleFor: ReadonlySet<Tier>;
  /**
   * Payload the bot runs on when the step is hidden for the cliente's
   * tier. Always a non-null JSON object so the bot config-loader can
   * treat `effectivePayload` as a flat dict with no missing-key checks.
   */
  defaultPayload: Readonly<Record<string, unknown>>;
}

// =============================================================================
// Catalog (frozen). The values are intentionally a superset of the BE-2
// allowlist (12 entries) so the operator view can present Step 12 even
// though v1 does not let the cliente touch it.
// =============================================================================

export const WIZARD_STEP_CATALOG: ReadonlyArray<WizardStepCatalogEntry> = Object.freeze([
  Object.freeze({
    number: 1,
    key: '1',
    label: 'Identidad del negocio',
    block: 'setup',
    visibleFor: new Set<Tier>(['starter', 'pro', 'premium']),
    defaultPayload: Object.freeze({}) as Readonly<Record<string, unknown>>,
  }),
  Object.freeze({
    number: 2,
    key: '2',
    label: 'Tono y voz',
    block: 'setup',
    visibleFor: new Set<Tier>(['starter', 'pro', 'premium']),
    defaultPayload: Object.freeze({ tono: 'amigable' }) as Readonly<Record<string, unknown>>,
  }),
  Object.freeze({
    number: 3,
    key: '3',
    label: 'Servicios y precios',
    block: 'services',
    visibleFor: new Set<Tier>(['pro', 'premium']),
    defaultPayload: Object.freeze({
      servicios: [],
      precio_tipo: 'consultar',
    }) as Readonly<Record<string, unknown>>,
  }),
  Object.freeze({
    number: 4,
    key: '4',
    label: 'Preguntas frecuentes',
    block: 'setup',
    visibleFor: new Set<Tier>(['starter', 'pro', 'premium']),
    defaultPayload: Object.freeze({}) as Readonly<Record<string, unknown>>,
  }),
  Object.freeze({
    number: 5,
    key: '5',
    label: 'Horario y datos de contacto',
    block: 'setup',
    visibleFor: new Set<Tier>(['starter', 'pro', 'premium']),
    defaultPayload: Object.freeze({}) as Readonly<Record<string, unknown>>,
  }),
  Object.freeze({
    number: 6,
    key: '6',
    label: 'Saludo inicial',
    block: 'setup',
    visibleFor: new Set<Tier>(['starter', 'pro', 'premium']),
    defaultPayload: Object.freeze({}) as Readonly<Record<string, unknown>>,
  }),
  Object.freeze({
    number: 7,
    key: '7',
    label: 'Reglas de derivación',
    block: 'services',
    visibleFor: new Set<Tier>(['pro', 'premium']),
    defaultPayload: Object.freeze({
      reglas: [],
      fallback_sin_respuesta: 'derivar',
    }) as Readonly<Record<string, unknown>>,
  }),
  Object.freeze({
    number: 8,
    key: '8',
    label: 'Idiomas',
    block: 'setup',
    visibleFor: new Set<Tier>(['starter', 'pro', 'premium']),
    defaultPayload: Object.freeze({ idioma_por_defecto: 'es' }) as Readonly<Record<string, unknown>>,
  }),
  Object.freeze({
    number: 9,
    key: '9',
    label: 'Aviso legal y privacidad',
    block: 'setup',
    visibleFor: new Set<Tier>(['starter', 'pro', 'premium']),
    defaultPayload: Object.freeze({}) as Readonly<Record<string, unknown>>,
  }),
  Object.freeze({
    number: 10,
    key: '10',
    label: 'Mensajes de cierre',
    block: 'setup',
    visibleFor: new Set<Tier>(['starter', 'pro', 'premium']),
    defaultPayload: Object.freeze({}) as Readonly<Record<string, unknown>>,
  }),
  Object.freeze({
    number: 11,
    key: '11',
    label: 'Pruebas y simulaciones',
    block: 'review',
    visibleFor: new Set<Tier>(['starter', 'pro', 'premium']),
    defaultPayload: Object.freeze({}) as Readonly<Record<string, unknown>>,
  }),
  // Step 12 is part of v1.1 (credentials vault). Hidden in v1 for every tier.
  Object.freeze({
    number: 12,
    key: '12',
    label: 'Integraciones (v1.1)',
    block: 'setup',
    visibleFor: new Set<Tier>([]),
    defaultPayload: Object.freeze({}) as Readonly<Record<string, unknown>>,
  }),
]);

const CATALOG_BY_NUMBER: ReadonlyMap<WizardStepNumber, WizardStepCatalogEntry> = new Map(
  WIZARD_STEP_CATALOG.map((e) => [e.number, e]),
);

const CATALOG_BY_KEY: ReadonlyMap<string, WizardStepCatalogEntry> = new Map(
  WIZARD_STEP_CATALOG.map((e) => [e.key, e]),
);

export function isValidStepNumber(n: number): n is WizardStepNumber {
  return Number.isInteger(n) && n >= 1 && n <= 12;
}

export function isValidStepKey(key: string): boolean {
  return CATALOG_BY_KEY.has(key);
}

export function getCatalogEntryByNumber(n: number): WizardStepCatalogEntry | null {
  return isValidStepNumber(n) ? (CATALOG_BY_NUMBER.get(n) ?? null) : null;
}

export function getCatalogEntryByKey(key: string): WizardStepCatalogEntry | null {
  return CATALOG_BY_KEY.get(key) ?? null;
}

// =============================================================================
// Visibility matrix.
// =============================================================================

/**
 * Returns whether a step is visible to a cliente on the given tier.
 * Step 12 is hidden for every tier in v1; the operator view uses
 * `isOperatorVisible` instead and ignores this gate.
 */
export function isVisibleForTier(number: WizardStepNumber, tier: Tier): boolean {
  const entry = CATALOG_BY_NUMBER.get(number);
  if (!entry) return false;
  return entry.visibleFor.has(tier);
}

/**
 * The operator view is tier-agnostic. Step 12 is shown to the operator
 * even though the cliente never sees it — the operator needs to know
 * it exists.
 */
export function isOperatorVisible(number: WizardStepNumber): boolean {
  return CATALOG_BY_NUMBER.has(number);
}

// =============================================================================
// Composed responses.
// =============================================================================

export interface ClientStepListEntry {
  number: WizardStepNumber;
  key: string;
  label: string;
  block: 'setup' | 'services' | 'review';
  /** Always true in the cliente view. Hidden steps are filtered out. */
  visible: true;
  /**
   * True when the step is hidden for the cliente's tier and the
   * server is returning the catalog default. The cliente UI uses this
   * to render the "auto-configured by your plan" badge.
   */
  autoConfigured: boolean;
  /** Server-managed default — present for every entry for shape stability. */
  defaultPayload: Readonly<Record<string, unknown>>;
}

export interface OperatorStepListEntry {
  number: WizardStepNumber;
  key: string;
  label: string;
  block: 'setup' | 'services' | 'review';
  /** Always true in the operator view. */
  visible: true;
  /** The cliente's tier as recorded in the DB — surfaced for operator context. */
  tier: Tier;
  /**
   * True only when the cliente's saved payload is null on a step that
   * is hidden for their tier. The operator UI uses this to highlight
   * "the bot is running on defaults".
   */
  autoConfigured: boolean;
  defaultPayload: Readonly<Record<string, unknown>>;
}

export interface ClientStepListResponse {
  clientId: string;
  tier: Tier;
  steps: ClientStepListEntry[];
}

export interface OperatorStepListResponse {
  clientId: string;
  tier: Tier;
  steps: OperatorStepListEntry[];
}

/**
 * Cliente step list — only the steps the cliente can interact with.
 * Hidden steps are filtered out (not marked `visible: false`) so the
 * cliente UI does not have to special-case them — a hidden Step 3 just
 * is not in the list.
 */
export function listStepsForClient(tier: Tier): ClientStepListEntry[] {
  return WIZARD_STEP_CATALOG.filter((e) => e.visibleFor.has(tier)).map((e) => ({
    number: e.number,
    key: e.key,
    label: e.label,
    block: e.block,
    visible: true,
    autoConfigured: false, // in the visible-list view there is nothing to auto-configure
    defaultPayload: e.defaultPayload,
  }));
}

/**
 * Operator step list — always the full 12 entries. The operator needs
 * to see Step 12 even when no cliente can touch it.
 */
export function listStepsForOperator(tier: Tier): OperatorStepListEntry[] {
  return WIZARD_STEP_CATALOG.map((e) => ({
    number: e.number,
    key: e.key,
    label: e.label,
    block: e.block,
    visible: true,
    tier,
    autoConfigured: false, // operator view shows the cliente's saved payload separately
    defaultPayload: e.defaultPayload,
  }));
}

// =============================================================================
// Single-step resolution. The DB layer supplies the saved payload; these
// helpers compose it with the catalog to produce the response shapes.
// =============================================================================

export interface SavedStepRecord {
  payload: Record<string, unknown> | null;
  status: string;
  version: number;
}

export interface ClientStepDataResponse {
  stepNumber: WizardStepNumber;
  stepKey: string;
  clientId: string;
  tier: Tier;
  /** What the bot runs on. Either the saved payload (visible step with data) or the catalog default (hidden step, or visible step with no data yet). */
  effectivePayload: Record<string, unknown>;
  /** The cliente's most recent saved payload for this step, regardless of visibility. null when none. */
  savedPayload: Record<string, unknown> | null;
  /**
   * True when the bot is running on the catalog default because the
   * step is hidden for the cliente's tier (server-managed). Also true
   * for Step 12 regardless of tier. False otherwise.
   */
  autoConfigured: boolean;
  /** Visibility for the cliente UI. Hidden steps return 404 from the route. */
  visible: boolean;
}

export interface OperatorStepDataResponse {
  stepNumber: WizardStepNumber;
  stepKey: string;
  clientId: string;
  tier: Tier;
  savedPayload: Record<string, unknown> | null;
  defaultPayload: Record<string, unknown>;
  /** Always true in the operator view (operator can always see every step). */
  autoConfigured: boolean;
  status: string | null;
  version: number | null;
}

export type ResolvedClientStep =
  | { kind: 'found'; data: ClientStepDataResponse }
  | { kind: 'hidden'; data: ClientStepDataResponse }
  | { kind: 'not_found' };

/**
 * Resolve a cliente step. Three outcomes:
 *  - 'found'    : the step is visible for the tier; return saved+default.
 *  - 'hidden'   : the step is hidden for the tier (Step 3 / 7 for Starter,
 *                 or Step 12 for any tier). Return defaults.
 *  - 'not_found': the step number is out of the v1 range.
 *
 * The caller is expected to map 'not_found' and out-of-range to a 4xx
 * response, and 'hidden' to a 200 with `autoConfigured: true`.
 */
export function resolveClientStep(
  number: WizardStepNumber,
  tier: Tier,
  saved: SavedStepRecord | null,
): ResolvedClientStep {
  if (!isValidStepNumber(number)) return { kind: 'not_found' };
  const entry = CATALOG_BY_NUMBER.get(number);
  if (!entry) return { kind: 'not_found' };

  const visible = entry.visibleFor.has(tier);
  const defaultPayload = entry.defaultPayload as Record<string, unknown>;
  const savedPayload = (saved?.payload ?? null) as Record<string, unknown> | null;

  if (visible) {
    return {
      kind: 'found',
      data: {
        stepNumber: number,
        stepKey: entry.key,
        clientId: '', // populated by the caller (route has the clientId)
        tier,
        effectivePayload: savedPayload ?? defaultPayload,
        savedPayload,
        autoConfigured: savedPayload === null,
        visible: true,
      },
    };
  }

  // Hidden step. The bot runs on the catalog default; we still surface
  // the saved payload for FE introspection and operator audit.
  return {
    kind: 'hidden',
    data: {
      stepNumber: number,
      stepKey: entry.key,
      clientId: '',
      tier,
      effectivePayload: defaultPayload,
      savedPayload,
      autoConfigured: true,
      visible: false,
    },
  };
}

/**
 * Resolve a step for the operator view. Always returns the catalog
 * entry + the cliente's saved payload (or null) so the operator can
 * see what the cliente has on file vs. what the bot is running on.
 */
export interface ResolvedOperatorStep {
  kind: 'found' | 'not_found';
  data?: OperatorStepDataResponse;
}

export function resolveOperatorStep(
  number: WizardStepNumber,
  tier: Tier,
  saved: SavedStepRecord | null,
): ResolvedOperatorStep {
  if (!isValidStepNumber(number)) return { kind: 'not_found' };
  const entry = CATALOG_BY_NUMBER.get(number);
  if (!entry) return { kind: 'not_found' };

  const defaultPayload = entry.defaultPayload as Record<string, unknown>;
  const savedPayload = (saved?.payload ?? null) as Record<string, unknown> | null;

  return {
    kind: 'found',
    data: {
      stepNumber: number,
      stepKey: entry.key,
      clientId: '',
      tier,
      savedPayload,
      defaultPayload,
      // In the operator view: the bot is "auto-configured" (running on
      // defaults) only when there is no saved payload AND the step is
      // hidden for the cliente's tier. When the cliente has saved data
      // we surface the data as the active config, not the default.
      autoConfigured: savedPayload === null && !entry.visibleFor.has(tier),
      status: saved?.status ?? null,
      version: saved?.version ?? null,
    },
  };
}
