// =============================================================================
// El botón «No quiere que le contactemos» (src/lib/lead-opt-out.ts) y su ruta.
//
// Lo que importa: que la oposición pare TODO lo que se le puede mandar —el
// lead y los otros locales con su mismo teléfono—, que deje la marca que leen
// el bloqueo y el borrado, y que no se pueda usar sobre el lead de otro
// cliente.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { NextRequest } from 'next/server';
import { canRegisterOptOut, registerLeadOptOut } from '@/lib/lead-opt-out';

const NOW = new Date('2026-09-29T18:00:00.000Z');

const state = {
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn((arg: unknown) => ({ op: 'update', arg })),
  auditCreate: vi.fn((arg: unknown) => ({ op: 'audit', arg })),
  transaction: vi.fn(async (ops: unknown[]) => ops),
};

const prisma = {
  lead: { findUnique: state.findUnique, findMany: state.findMany, update: state.update },
  leadAudit: { create: state.auditCreate },
  $transaction: state.transaction,
} as unknown as PrismaClient;

function lead(overrides: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    clientId: 'c1',
    tenantId: null,
    source: 'outbound',
    status: 'contactado',
    optedOutAt: null,
    discardedAt: null,
    contactPhone: '+34 600 11 22 33',
    ...overrides,
  };
}

beforeEach(() => {
  state.findUnique.mockReset().mockResolvedValue(lead());
  state.findMany.mockReset().mockResolvedValue([]);
  state.update.mockClear();
  state.auditCreate.mockClear();
  state.transaction.mockClear();
});

describe('canRegisterOptOut', () => {
  it('solo prospectos que no se hayan opuesto ya ni sean clientes', () => {
    expect(canRegisterOptOut({ source: 'outbound', status: 'nuevo', optedOutAt: null })).toBe(true);
    // Un descarte por «no encaja» puede pasar a oposición después.
    expect(canRegisterOptOut({ source: 'outbound', status: 'descartado', optedOutAt: null })).toBe(true);
    expect(canRegisterOptOut({ source: 'outbound', status: 'nuevo', optedOutAt: NOW })).toBe(false);
    expect(canRegisterOptOut({ source: 'outbound', status: 'convertido', optedOutAt: null })).toBe(false);
    expect(canRegisterOptOut({ source: 'chatbot', status: 'nuevo', optedOutAt: null })).toBe(false);
  });
});

describe('registerLeadOptOut', () => {
  it('descarta el lead, le pone la marca de oposición y lo audita', async () => {
    const result = await registerLeadOptOut(prisma, { clientId: 'c1', leadId: 'l1', actorId: 'client:c1', now: NOW });

    expect(result).toEqual({ ok: true, leadIds: ['l1'] });
    expect(state.update).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: { status: 'descartado', discardedAt: NOW, optedOutAt: NOW, staleAlertSentAt: null },
    });
    expect(state.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        leadId: 'l1',
        action: 'opted_out',
        statusBefore: 'contactado',
        statusAfter: 'descartado',
        actorId: 'client:c1',
      }),
    });
    expect(state.transaction).toHaveBeenCalledTimes(1);
  });

  it('marca también a los otros locales con el mismo teléfono: la oposición es de la persona', async () => {
    state.findMany.mockResolvedValue([
      { id: 'l2', tenantId: null, status: 'nuevo', discardedAt: null, contactPhone: '600112233' },
      { id: 'l3', tenantId: null, status: 'nuevo', discardedAt: null, contactPhone: '+34 699 99 99 99' },
    ]);

    const result = await registerLeadOptOut(prisma, { clientId: 'c1', leadId: 'l1', actorId: 'client:c1', now: NOW });

    expect(result).toEqual({ ok: true, leadIds: ['l1', 'l2'] });
    const where = state.findMany.mock.calls[0][0].where;
    // Solo del mismo cliente, solo prospectos, y nunca un cliente convertido.
    expect(where).toMatchObject({ clientId: 'c1', source: 'outbound', optedOutAt: null, status: { not: 'convertido' } });
    expect(state.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'l3' } }));
  });

  it('un lead ya descartado conserva la fecha de su descarte', async () => {
    const before = new Date('2026-09-01T00:00:00.000Z');
    state.findUnique.mockResolvedValue(lead({ status: 'descartado', discardedAt: before }));
    await registerLeadOptOut(prisma, { clientId: 'c1', leadId: 'l1', actorId: 'client:c1', now: NOW });
    expect(state.update.mock.calls[0][0]).toMatchObject({ data: { discardedAt: before, optedOutAt: NOW } });
  });

  it('el lead de otro cliente es not_found, y no escribe nada', async () => {
    state.findUnique.mockResolvedValue(lead({ clientId: 'otro' }));
    const result = await registerLeadOptOut(prisma, { clientId: 'c1', leadId: 'l1', actorId: 'client:c1' });
    expect(result).toEqual({ ok: false, error: 'not_found' });
    expect(state.transaction).not.toHaveBeenCalled();
  });

  it('dos veces sobre el mismo lead: la segunda no escribe nada', async () => {
    state.findUnique.mockResolvedValue(lead({ optedOutAt: NOW, status: 'descartado' }));
    const result = await registerLeadOptOut(prisma, { clientId: 'c1', leadId: 'l1', actorId: 'client:c1' });
    expect(result).toEqual({ ok: false, error: 'not_allowed' });
    expect(state.transaction).not.toHaveBeenCalled();
  });

  it('sin teléfono no busca hermanos', async () => {
    state.findUnique.mockResolvedValue(lead({ contactPhone: null }));
    const result = await registerLeadOptOut(prisma, { clientId: 'c1', leadId: 'l1', actorId: 'client:c1' });
    expect(result).toEqual({ ok: true, leadIds: ['l1'] });
    expect(state.findMany).not.toHaveBeenCalled();
  });
});

// --- La ruta -------------------------------------------------------------------

const routeState = vi.hoisted(() => ({
  hasClientAccess: true,
  resolved: { clientId: 'c1', source: 'database' } as { clientId: string; source: string } | null,
  register: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: async () => ({ hasClientAccess: routeState.hasClientAccess }) }));
vi.mock('@/lib/portal-session', () => ({ resolveClientFromSession: async () => routeState.resolved }));
vi.mock('@/lib/prisma', () => ({ prisma: {}, isDatabaseConfigured: true }));

describe('POST /api/portal/leads/[id]/opt-out', () => {
  beforeEach(() => {
    routeState.hasClientAccess = true;
    routeState.resolved = { clientId: 'c1', source: 'database' };
  });

  async function post(id = 'l1') {
    vi.resetModules();
    vi.doMock('@/lib/lead-opt-out', () => ({ registerLeadOptOut: routeState.register }));
    const { POST } = await import('@/app/api/portal/leads/[id]/opt-out/route');
    return POST({} as NextRequest, { params: { id } });
  }

  it('401 sin sesión de cliente', async () => {
    routeState.hasClientAccess = false;
    routeState.register.mockReset();
    const res = await post();
    expect(res.status).toBe(401);
    expect(routeState.register).not.toHaveBeenCalled();
  });

  it('el cliente sale de la sesión, nunca de la petición', async () => {
    routeState.register.mockReset().mockResolvedValue({ ok: true, leadIds: ['l1'] });
    const res = await post('l1');
    expect(res.status).toBe(200);
    expect(routeState.register).toHaveBeenCalledWith({}, { clientId: 'c1', leadId: 'l1', actorId: 'client:c1' });
  });

  it('404 para un lead ajeno y 409 si ya estaba registrada', async () => {
    routeState.register.mockReset().mockResolvedValue({ ok: false, error: 'not_found' });
    expect((await post()).status).toBe(404);
    routeState.register.mockReset().mockResolvedValue({ ok: false, error: 'not_allowed' });
    expect((await post()).status).toBe(409);
  });
});
