// =============================================================================
// WP-15 — De un catálogo a un registro de catálogos.
//
// wizard-catalog.ts used to be the single source of truth for "the wizard
// catalog" — implicitly the chatbot's, since chatbot was the only product
// with a wizard. Kairikos now sells five products (WP-12); this module is
// the registry every future per-product wizard reads from.
//
// Only 'chatbot' has real step content today — the other four products
// don't have a wizard yet (that lands in WP-16, which builds the actual
// multi-product routing). Their entries are deliberately empty catalogs
// rather than omitted keys, so `getProductCatalog('web')` returns a valid
// (if empty) catalog instead of throwing — a caller iterating
// PRODUCT_CATALOGS to render a cross-product summary doesn't need a
// special case for "not built yet".
//
// Pure module: no I/O, no Prisma, frozen with Object.freeze. Matches the
// existing wizard-catalog.ts convention (see WIZARD_STEP_CATALOG in that
// now-deprecated shim).
// =============================================================================

import type { WizardStepDefinition, WizardBlock } from './types';
import { CHATBOT_STEPS, CHATBOT_MILESTONES, CHATBOT_BLOCKS } from './chatbot';

export type {
  WizardStepDefinition,
  WizardTier,
  WizardBlock,
  WizardStepNumber,
} from './types';

// Matches prisma/seed.ts's PRODUCT_CATALOG codes (WP-12/WP-15) — 'leads'
// and 'reviews' are the Kairikos-internal codes for "Sistema IA de
// captación" and "Reseñas en Google" respectively, not literal Spanish
// translations of the product name.
export type ProductCode = 'chatbot' | 'web' | 'leads' | 'seo' | 'reviews';

export const PRODUCT_CODES: readonly ProductCode[] = Object.freeze([
  'chatbot',
  'web',
  'leads',
  'seo',
  'reviews',
]);

export interface ProductCatalog {
  readonly code: ProductCode;
  readonly label: string;
  readonly steps: Readonly<Record<string, WizardStepDefinition>>;
  readonly stepKeys: readonly string[];
  readonly requiredStepKeys: readonly string[];
  readonly milestones: readonly string[];
  readonly blocks: readonly WizardBlock[];
}

function stepKeysOf(steps: Readonly<Record<string, WizardStepDefinition>>): readonly string[] {
  return Object.freeze(Object.values(steps).map((s) => s.key));
}

function requiredStepKeysOf(steps: Readonly<Record<string, WizardStepDefinition>>): readonly string[] {
  return Object.freeze(
    Object.values(steps)
      .filter((s) => s.requiredForReady)
      .map((s) => s.key),
  );
}

// Generic onboarding timeline shared by every product until a product
// defines its own — matches the existing T+0/T+3/T+7/T+14 milestone
// vocabulary already used across the portal (ALLOWED_MILESTONES,
// onboarding-actions.ts) for the chatbot product.
const DEFAULT_MILESTONES: readonly string[] = Object.freeze(['T+0', 'T+3', 'T+7', 'T+14']);

const EMPTY_STEPS: Readonly<Record<string, WizardStepDefinition>> = Object.freeze({});

function emptyCatalog(code: ProductCode, label: string): ProductCatalog {
  return Object.freeze({
    code,
    label,
    steps: EMPTY_STEPS,
    stepKeys: Object.freeze([]),
    requiredStepKeys: Object.freeze([]),
    milestones: DEFAULT_MILESTONES,
    blocks: Object.freeze([]),
  });
}

export const PRODUCT_CATALOGS: Readonly<Record<ProductCode, ProductCatalog>> = Object.freeze({
  chatbot: Object.freeze({
    code: 'chatbot',
    label: 'Chatbot IA',
    steps: CHATBOT_STEPS,
    stepKeys: stepKeysOf(CHATBOT_STEPS),
    requiredStepKeys: requiredStepKeysOf(CHATBOT_STEPS),
    milestones: CHATBOT_MILESTONES,
    blocks: CHATBOT_BLOCKS,
  }),
  // WP-16 gives these their own step content. Until then: valid, empty,
  // sellable-in-the-catalog (WP-12) but not yet configurable-via-wizard.
  web: emptyCatalog('web', 'Plataforma web profesional'),
  leads: emptyCatalog('leads', 'Sistema IA de captación'),
  seo: emptyCatalog('seo', 'SEO y contenido con IA'),
  reviews: emptyCatalog('reviews', 'Reseñas en Google'),
});

export class ProductCatalogError extends Error {
  constructor(public readonly code: string) {
    super(`unknown product code: ${code}`);
    this.name = 'ProductCatalogError';
  }
}

/** Resolve a product's catalog. Throws ProductCatalogError for an unknown code. */
export function getProductCatalog(code: string): ProductCatalog {
  const catalog = (PRODUCT_CATALOGS as Record<string, ProductCatalog | undefined>)[code];
  if (!catalog) {
    throw new ProductCatalogError(code);
  }
  return catalog;
}

/** Validate a raw stepKey against a specific product's catalog. Throws
 *  ProductCatalogError (reusing the same error type — "not found in this
 *  catalog" is the same failure mode as "catalog not found") when `raw`
 *  isn't one of the catalog's stepKeys. */
export function parseStepKey(catalog: ProductCatalog, raw: string): string {
  if (!catalog.stepKeys.includes(raw)) {
    throw new ProductCatalogError(`${catalog.code}:${raw}`);
  }
  return raw;
}
