// =============================================================================
// Plan de precios del 01/10/2026 — las dos reglas de producto que trajo.
//
// 1. Llamadas Esencial no lleva franjas de devolución, resumen diario ni
//    informe mensual. Si la regla se rompe hacia un lado, se regala lo que
//    distingue a Autónomo; hacia el otro, se le quita a quien paga Autónomo.
// 2. Chatbot Premium incluye la captación. Si se rompe, un cliente Premium
//    se queda sin bandeja que ya paga, o se le cobra dos veces.
//
// Los barridos se comprueban por el filtro que mandan a Prisma: la suite
// mockea Prisma, así que el filtro se probó además contra el Postgres local
// (CLAUDE.md, «los tests unitarios mockean Prisma»).
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { RECALL_ESSENTIAL_TIERS, RECALL_WITH_EXTRAS_WHERE, recallTierIncludesExtras } from '@/lib/recall';
import {
  findLeadsEntitlement,
  hasLeadsProduct,
  LEADS_ENTITLEMENT_WHERE,
  LEADS_INCLUDED_CHATBOT_TIERS,
} from '@/lib/lead-entitlement';
import { PRODUCT_CATALOG } from '../../prisma/seed';

describe('Llamadas Esencial', () => {
  it('solo Esencial se queda sin franjas, resumen ni informe', () => {
    expect(recallTierIncludesExtras('essential')).toBe(false);
    for (const tier of ['solo', 'team', 'business']) {
      expect(recallTierIncludesExtras(tier)).toBe(true);
    }
  });

  it('un escalón desconocido o ausente los lleva: equivocarse dando de más', () => {
    expect(recallTierIncludesExtras(undefined)).toBe(true);
    expect(recallTierIncludesExtras(null)).toBe(true);
    expect(recallTierIncludesExtras('Essential')).toBe(true);
  });

  it('el filtro de los barridos excluye exactamente esos escalones', () => {
    expect(RECALL_WITH_EXTRAS_WHERE).toEqual({
      clientProduct: { product: { tier: { notIn: ['essential'] } } },
    });
  });

  it('el escalón existe en el catálogo con el nombre de la constante', () => {
    const tiers = PRODUCT_CATALOG.filter((p) => p.code === 'recall').map((p) => p.tier);
    for (const t of RECALL_ESSENTIAL_TIERS) expect(tiers).toContain(t);
  });
});

describe('captación incluida en Chatbot Premium', () => {
  function fakePrisma(rows: { code: string; tier: string; id: string }[]) {
    const findFirst = vi.fn(async ({ where }: { where: { product: { code: string; tier?: { in: string[] } } } }) => {
      const row = rows.find(
        (r) => r.code === where.product.code && (!where.product.tier || where.product.tier.in.includes(r.tier)),
      );
      return row ? { id: row.id, tenantId: 't1' } : null;
    });
    return { prisma: { clientProduct: { findFirst } } as unknown as PrismaClient, findFirst };
  }

  it('Premium la incluye; Web y Pro no', () => {
    expect(LEADS_INCLUDED_CHATBOT_TIERS).toEqual(['premium']);
    expect(LEADS_ENTITLEMENT_WHERE).toEqual({
      status: 'active',
      OR: [{ product: { code: 'leads' } }, { product: { code: 'chatbot', tier: { in: ['premium'] } } }],
    });
  });

  it('un cliente con Premium y sin el complemento tiene captación', async () => {
    const { prisma } = fakePrisma([{ code: 'chatbot', tier: 'premium', id: 'cp-premium' }]);
    await expect(hasLeadsProduct(prisma, 'c1')).resolves.toBe(true);
    await expect(findLeadsEntitlement(prisma, 'c1')).resolves.toEqual({ id: 'cp-premium', tenantId: 't1' });
  });

  it('un cliente con Pro y sin el complemento no la tiene', async () => {
    const { prisma } = fakePrisma([{ code: 'chatbot', tier: 'pro', id: 'cp-pro' }]);
    await expect(hasLeadsProduct(prisma, 'c1')).resolves.toBe(false);
  });

  it('con los dos, manda el complemento: de él cuelga el perfil que ya tenía', async () => {
    const { prisma, findFirst } = fakePrisma([
      { code: 'chatbot', tier: 'premium', id: 'cp-premium' },
      { code: 'leads', tier: 'standard', id: 'cp-leads' },
    ]);
    await expect(findLeadsEntitlement(prisma, 'c1')).resolves.toEqual({ id: 'cp-leads', tenantId: 't1' });
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('solo cuenta lo activo', async () => {
    const { prisma, findFirst } = fakePrisma([]);
    await findLeadsEntitlement(prisma, 'c1');
    for (const [arg] of findFirst.mock.calls) {
      expect(arg.where).toMatchObject({ clientId: 'c1', status: 'active' });
    }
  });
});
