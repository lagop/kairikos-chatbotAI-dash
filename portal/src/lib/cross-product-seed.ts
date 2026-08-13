import type { Prisma, PrismaClient } from '@prisma/client';
import type { ProductCode } from './catalogs';
import { jsonToObject } from './wizard-tier-prisma';

// =============================================================================
// WP-29 — precargar datos comunes cuando el cliente ya los dio en otro
// producto.
//
// Same principle WP-24 already applies for intake→wizard, generalized to
// wizard→wizard between two products of the same client: if a client
// already answered a field while configuring product A, and product B's
// wizard asks the same thing, product B's step opens pre-filled with that
// value (marked "heredado de <producto>", editable) instead of a blank
// field the client has to retype.
//
// CROSS_PRODUCT_FIELD_MAP is deliberately empty today. The one concrete
// correspondence the plan documents — chatbot Step 6 ("Captación de
// leads") ↔ the 'leads' product's qualification step — can't be encoded
// yet because 'leads' (like 'web'/'seo'/'reviews') is still an empty
// catalog (WP-15): there is no real stepKey/field on the other side to
// point at. This file ships the mechanism — the table shape, the pure
// resolver, and the Prisma-backed lookup — so the day a product's real
// catalog lands, populating CROSS_PRODUCT_FIELD_MAP is the only work left;
// nothing about the wizard step page needs to change again.
//
// Precarga is read-time only: it never writes a ChatbotConfigStep row.
// The inherited value is merged into `effectivePayload` exactly like the
// catalog default is today (see wizard-visibility.ts's resolveClientStep)
// — the moment the client saves ANY version of the target step, that real
// row becomes `savedPayload`, which always wins over an inherited value.
// That's the whole mechanism behind "the target product keeps its own
// copy from the moment it's touched" (AC #3) — no extra flag to track or
// clear.
// =============================================================================

export interface FieldRef {
  productCode: ProductCode;
  stepKey: string;
  /** Key inside that step's JSON payload. */
  field: string;
}

export interface CrossProductFieldMapping {
  from: FieldRef;
  to: FieldRef;
}

/**
 * Correspondence table between stepKeys/fields of different product
 * catalogs. Kept as a single flat list (not scattered per-catalog) so a
 * reviewer can see every cross-product relationship in one place.
 *
 * Empty today — see the header comment above. Add entries here, not in
 * the catalog files themselves, once a target product's real step exists.
 */
export const CROSS_PRODUCT_FIELD_MAP: readonly CrossProductFieldMapping[] = [];

export interface InheritedField {
  /** The target step's field name (i.e. the key this value lands under
   *  in the merged payload). */
  field: string;
  fromProductCode: ProductCode;
}

export interface InheritedSeed {
  /** Values to merge into the target step's effectivePayload — only the
   *  fields that had a non-empty source value. Never mutates the caller's
   *  own payload object. */
  payload: Record<string, unknown>;
  /** Which fields came from where, for the "heredado de <producto>" UI
   *  marker. Empty when nothing was inherited. */
  inheritedFrom: InheritedField[];
}

const EMPTY_SEED: InheritedSeed = { payload: {}, inheritedFrom: [] };

/**
 * Pure resolver: given a target (productCode, stepKey) and a way to look
 * up an arbitrary source step's saved payload, compute what should be
 * inherited. Takes `mappings` as an explicit parameter (defaulting to the
 * real table) so this can be unit-tested against a synthetic table
 * without waiting for a real second catalog to exist.
 */
export function resolveInheritedFields(
  targetProductCode: string,
  targetStepKey: string,
  lookupSourcePayload: (source: FieldRef) => Record<string, unknown> | null,
  mappings: readonly CrossProductFieldMapping[] = CROSS_PRODUCT_FIELD_MAP,
): InheritedSeed {
  const relevant = mappings.filter(
    (m) => m.to.productCode === targetProductCode && m.to.stepKey === targetStepKey,
  );
  if (relevant.length === 0) return EMPTY_SEED;

  const payload: Record<string, unknown> = {};
  const inheritedFrom: InheritedField[] = [];
  for (const mapping of relevant) {
    const sourcePayload = lookupSourcePayload(mapping.from);
    const value = sourcePayload?.[mapping.from.field];
    if (value === undefined || value === null) continue;
    payload[mapping.to.field] = value;
    inheritedFrom.push({ field: mapping.to.field, fromProductCode: mapping.from.productCode });
  }
  if (inheritedFrom.length === 0) return EMPTY_SEED;
  return { payload, inheritedFrom };
}

/**
 * Prisma-backed wrapper: resolves the mappings relevant to `targetStepKey`,
 * fetches each distinct source step's LATEST saved payload (not gated on
 * activeForBot — the client already typed it, that's enough to offer it
 * as a starting point elsewhere), and delegates the merge to
 * `resolveInheritedFields`.
 *
 * Returns the empty seed (no Prisma calls at all) when no mapping targets
 * this step — the common case today, since the table is empty.
 */
export async function getCrossProductSeed(
  prisma: PrismaClient,
  clientId: string,
  targetProductCode: string,
  targetStepKey: string,
  // Defaults to the real table; overridable so tests can exercise the
  // Prisma-backed merge without waiting for a real second catalog to
  // populate CROSS_PRODUCT_FIELD_MAP.
  mappings: readonly CrossProductFieldMapping[] = CROSS_PRODUCT_FIELD_MAP,
): Promise<InheritedSeed> {
  const relevant = mappings.filter(
    (m) => m.to.productCode === targetProductCode && m.to.stepKey === targetStepKey,
  );
  if (relevant.length === 0) return EMPTY_SEED;

  const sources = new Map<string, FieldRef>();
  for (const mapping of relevant) {
    sources.set(`${mapping.from.productCode}:${mapping.from.stepKey}`, mapping.from);
  }

  const sourcePayloads = new Map<string, Record<string, unknown> | null>();
  await Promise.all(
    Array.from(sources.entries()).map(async ([key, source]) => {
      const row = await prisma.chatbotConfigStep.findFirst({
        where: { clientId, productCode: source.productCode, stepKey: source.stepKey },
        orderBy: { version: 'desc' },
        select: { payload: true },
      });
      sourcePayloads.set(key, jsonToObject((row?.payload as Prisma.JsonValue | undefined) ?? null));
    }),
  );

  return resolveInheritedFields(
    targetProductCode,
    targetStepKey,
    (source) => sourcePayloads.get(`${source.productCode}:${source.stepKey}`) ?? null,
    mappings,
  );
}
