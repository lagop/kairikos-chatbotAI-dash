// =============================================================================
// WP-29 — unit tests for src/lib/cross-product-seed.ts.
//
// CROSS_PRODUCT_FIELD_MAP itself is empty today (see that file's header
// comment — no second product has real catalog content yet), so these
// tests exercise the resolver/wrapper logic against a synthetic mapping
// table passed in explicitly, exactly the way a real chatbot↔leads entry
// will be tested once one exists.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import {
  resolveInheritedFields,
  getCrossProductSeed,
  CROSS_PRODUCT_FIELD_MAP,
  type CrossProductFieldMapping,
} from '@/lib/cross-product-seed';

const CHATBOT_TO_LEADS_MAPPING: CrossProductFieldMapping = {
  from: { productCode: 'chatbot', stepKey: '6', field: 'criterios_calificacion' },
  to: { productCode: 'leads', stepKey: '3', field: 'criterios_calificacion' },
};

describe('CROSS_PRODUCT_FIELD_MAP (shipped table)', () => {
  it('is empty — no second product has real catalog content yet', () => {
    expect(CROSS_PRODUCT_FIELD_MAP).toEqual([]);
  });
});

describe('resolveInheritedFields', () => {
  it('returns an empty seed when no mapping targets this step', () => {
    const seed = resolveInheritedFields('leads', '99', () => ({ foo: 'bar' }), [
      CHATBOT_TO_LEADS_MAPPING,
    ]);
    expect(seed).toEqual({ payload: {}, inheritedFrom: [] });
  });

  it('inherits the source field when it has a value', () => {
    const seed = resolveInheritedFields(
      'leads',
      '3',
      (source) => {
        expect(source).toEqual({ productCode: 'chatbot', stepKey: '6', field: 'criterios_calificacion' });
        return { criterios_calificacion: 'presupuesto > 5000€' };
      },
      [CHATBOT_TO_LEADS_MAPPING],
    );
    expect(seed).toEqual({
      payload: { criterios_calificacion: 'presupuesto > 5000€' },
      inheritedFrom: [{ field: 'criterios_calificacion', fromProductCode: 'chatbot' }],
    });
  });

  it('returns an empty seed when the source step has no saved payload', () => {
    const seed = resolveInheritedFields('leads', '3', () => null, [CHATBOT_TO_LEADS_MAPPING]);
    expect(seed).toEqual({ payload: {}, inheritedFrom: [] });
  });

  it('skips a field whose source value is null or undefined without dropping the others', () => {
    const secondMapping: CrossProductFieldMapping = {
      from: { productCode: 'chatbot', stepKey: '6', field: 'horario_respuesta' },
      to: { productCode: 'leads', stepKey: '3', field: 'horario_respuesta' },
    };
    const seed = resolveInheritedFields(
      'leads',
      '3',
      () => ({ criterios_calificacion: null, horario_respuesta: '9-18' }),
      [CHATBOT_TO_LEADS_MAPPING, secondMapping],
    );
    expect(seed.payload).toEqual({ horario_respuesta: '9-18' });
    expect(seed.inheritedFrom).toEqual([
      { field: 'horario_respuesta', fromProductCode: 'chatbot' },
    ]);
  });

  it('never mutates a caller-visible shared object across calls', () => {
    const seedA = resolveInheritedFields('leads', '3', () => ({ criterios_calificacion: 'a' }), [
      CHATBOT_TO_LEADS_MAPPING,
    ]);
    const seedB = resolveInheritedFields('leads', '3', () => ({ criterios_calificacion: 'b' }), [
      CHATBOT_TO_LEADS_MAPPING,
    ]);
    expect(seedA.payload.criterios_calificacion).toBe('a');
    expect(seedB.payload.criterios_calificacion).toBe('b');
  });
});

describe('getCrossProductSeed', () => {
  function makePrisma(payloadByStep: Record<string, unknown>) {
    return {
      chatbotConfigStep: {
        findFirst: vi.fn(({ where }: { where: { productCode: string; stepKey: string } }) => {
          const key = `${where.productCode}:${where.stepKey}`;
          return Promise.resolve(
            key in payloadByStep ? { payload: payloadByStep[key] } : null,
          );
        }),
      },
    } as never;
  }

  it('makes no Prisma calls when the table has no mapping for this step (today\'s real table)', async () => {
    const prisma = makePrisma({});
    const seed = await getCrossProductSeed(prisma, 'c1', 'leads', '3');
    expect(seed).toEqual({ payload: {}, inheritedFrom: [] });
    expect((prisma as { chatbotConfigStep: { findFirst: ReturnType<typeof vi.fn> } }).chatbotConfigStep.findFirst).not.toHaveBeenCalled();
  });

  it('reads the source step and merges its value in, given an injected mapping', async () => {
    const prisma = makePrisma({
      'chatbot:6': { criterios_calificacion: 'presupuesto > 5000€' },
    });
    const seed = await getCrossProductSeed(prisma, 'c1', 'leads', '3', [CHATBOT_TO_LEADS_MAPPING]);
    expect(seed).toEqual({
      payload: { criterios_calificacion: 'presupuesto > 5000€' },
      inheritedFrom: [{ field: 'criterios_calificacion', fromProductCode: 'chatbot' }],
    });
  });

  it('scopes the source read by clientId + productCode + stepKey', async () => {
    const prisma = makePrisma({ 'chatbot:6': { criterios_calificacion: 'x' } });
    await getCrossProductSeed(prisma, 'c1', 'leads', '3', [CHATBOT_TO_LEADS_MAPPING]);
    expect(
      (prisma as { chatbotConfigStep: { findFirst: ReturnType<typeof vi.fn> } }).chatbotConfigStep.findFirst,
    ).toHaveBeenCalledWith({
      where: { clientId: 'c1', productCode: 'chatbot', stepKey: '6' },
      orderBy: { version: 'desc' },
      select: { payload: true },
    });
  });

  it('returns an empty seed when the client has no saved data on the source step', async () => {
    const prisma = makePrisma({});
    const seed = await getCrossProductSeed(prisma, 'c1', 'leads', '3', [CHATBOT_TO_LEADS_MAPPING]);
    expect(seed).toEqual({ payload: {}, inheritedFrom: [] });
  });
});
