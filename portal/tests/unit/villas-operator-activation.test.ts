// =============================================================================
// Reserva de villas — alta desde «Productos contratados» (16/11/2026).
//
// El módulo vive en su VillaRental, no solo en la contratación. Asignar
// 'villas' por la activación genérica del operador (la del panel, pago por
// otro medio) tiene que dejarlo igual que POST /api/admin/portal/villas:
// con su VillaRental y su token, y reactivar dentro del plazo de gracia
// tiene que anular la baja. Y ningún otro producto toca villas.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/recall-onboarding', () => ({ ensureRecallSubscription: vi.fn() }));
vi.mock('@/lib/product-onboarding', () => ({
  ensureSeoProfile: vi.fn(),
  ensureProspectingCampaign: vi.fn(),
  ensureLeadQualificationProfile: vi.fn(),
  ensureConversationDigestSchedule: vi.fn(),
}));
vi.mock('@/lib/client-site', () => ({ assignSiteToNewContract: vi.fn(async () => ({ clientSiteId: 'site_1' })) }));

import type { PrismaClient } from '@prisma/client';
import { activateClientProductForOperator } from '@/lib/client-product-activation';

const PRODUCTS: Record<string, { id: string; code: string; tier: string; isActive: boolean }> = {
  p_villas: { id: 'p_villas', code: 'villas', tier: 'standard', isActive: true },
  p_leads: { id: 'p_leads', code: 'leads', tier: 'standard', isActive: true },
};

function fakeDb(opts: { existingContract?: { id: string; status: string }; existingRental?: { id: string; exitNotifiedAt: Date | null } } = {}) {
  const calls = {
    villaRentalCreate: [] as Array<Record<string, unknown>>,
    villaRentalUpdate: [] as Array<Record<string, unknown>>,
    villaAudit: [] as Array<Record<string, unknown>>,
    contractUpdate: [] as Array<Record<string, unknown>>,
  };
  const db = {
    chatbotClient: {
      findUnique: vi.fn(async () => ({ id: 'c_1', tenantId: 't_1', companyName: 'Sombra Buena', name: 'Sombra Buena (demo)' })),
    },
    product: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => PRODUCTS[where.id] ?? null) },
    clientProduct: {
      findFirst: vi.fn(async () => opts.existingContract ?? null),
      create: vi.fn(async ({ data }: { data: { productId: string } }) => ({ id: 'cp_new', tenantId: 't_1', product: PRODUCTS[data.productId] })),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.contractUpdate.push(args.data);
        return { id: args.where.id, tenantId: 't_1', product: PRODUCTS.p_villas };
      }),
    },
    clientProductAudit: { create: vi.fn(async () => ({})) },
    villaRental: {
      findUnique: vi.fn(async () => opts.existingRental ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.villaRentalCreate.push(data);
        return { id: 'vr_new' };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.villaRentalUpdate.push(data);
        return {};
      }),
    },
    villaRentalAudit: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.villaAudit.push(data);
        return {};
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db: db as unknown as PrismaClient, calls };
}

describe('activar villas desde «Productos contratados»', () => {
  beforeEach(() => vi.clearAllMocks());

  it('crea la VillaRental con su token y la deja en marcha', async () => {
    const { db, calls } = fakeDb();
    const r = await activateClientProductForOperator(db, { clientId: 'c_1', productId: 'p_villas' }, { operatorId: 'op_1' });

    expect(r).toMatchObject({ ok: true, productCode: 'villas', wasReactivated: false });
    expect(calls.villaRentalCreate).toHaveLength(1);
    expect(calls.villaRentalCreate[0]).toMatchObject({ clientProductId: 'cp_new', clientId: 'c_1', tenantId: 't_1', businessName: 'Sombra Buena' });
    expect(String(calls.villaRentalCreate[0].publicToken)).toMatch(/^vil_[A-Za-z0-9_-]{10,60}$/);
    expect(calls.villaAudit[0]).toMatchObject({ entity: 'rental', action: 'created', actor: 'operator:op_1' });
    expect(calls.contractUpdate).toContainEqual({ onboardingState: 'live' });
  });

  it('reactivar dentro del plazo de gracia anula la baja y no crea otra', async () => {
    const { db, calls } = fakeDb({
      existingContract: { id: 'cp_old', status: 'cancelled' },
      existingRental: { id: 'vr_old', exitNotifiedAt: new Date('2026-11-10T09:00:00Z') },
    });
    const r = await activateClientProductForOperator(db, { clientId: 'c_1', productId: 'p_villas' }, { operatorId: 'op_1' });

    expect(r).toMatchObject({ ok: true, wasReactivated: true });
    expect(calls.villaRentalCreate).toHaveLength(0);
    expect(calls.villaRentalUpdate).toEqual([{ exitNotifiedAt: null }]);
  });

  it('otro producto no toca villas', async () => {
    const { db, calls } = fakeDb();
    const r = await activateClientProductForOperator(db, { clientId: 'c_1', productId: 'p_leads' }, { operatorId: 'op_1' });

    expect(r).toMatchObject({ ok: true, productCode: 'leads' });
    expect(calls.villaRentalCreate).toHaveLength(0);
    expect(calls.villaRentalUpdate).toHaveLength(0);
    expect(calls.contractUpdate).toHaveLength(0);
  });
});
