// =============================================================================
// Prospección con IA, Fase A — unit tests for PATCH /api/portal/prospecting/campaign.
//
// Client self-serve, not operator-managed — see the route's own header
// for why. Covers: auth, the 'prospecting' product gate, lazy creation
// on first save (with the tier's TIER_LEAD_CAP), update on subsequent
// saves, and the audit trail for both.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  clientProductFindFirst: vi.fn(),
  campaignFindUnique: vi.fn(),
  campaignCreate: vi.fn(),
  campaignUpdate: vi.fn(),
  campaignAuditCreate: vi.fn(),
  searchDeleteMany: vi.fn(),
  searchUpdate: vi.fn(),
  searchCreateMany: vi.fn(),
  logError: vi.fn(),
}));

const mockTx = {
  prospectingCampaign: {
    create: (...a: unknown[]) => mockState.campaignCreate(...a),
    update: (...a: unknown[]) => mockState.campaignUpdate(...a),
  },
  prospectingCampaignAudit: { create: (...a: unknown[]) => mockState.campaignAuditCreate(...a) },
  prospectingSearch: {
    deleteMany: (...a: unknown[]) => mockState.searchDeleteMany(...a),
    update: (...a: unknown[]) => mockState.searchUpdate(...a),
    createMany: (...a: unknown[]) => mockState.searchCreateMany(...a),
  },
};

vi.mock('@/lib/session', () => ({
  getSession: (...a: unknown[]) => mockState.getSession(...a),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClientFromSession(...a),
}));

// @/lib/prospecting NO se mockea: la ruta usa sus funciones puras
// (normalizeSearches, diffSearches) y sus topes, y un mock que los copiara a
// mano comprobaría la copia, no lo que corre.

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    clientProduct: { findFirst: (...a: unknown[]) => mockState.clientProductFindFirst(...a) },
    prospectingCampaign: { findUnique: (...a: unknown[]) => mockState.campaignFindUnique(...a) },
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  },
}));

import { PATCH } from '@/app/api/portal/prospecting/campaign/route';

const SESSION_OK = { hasClientAccess: true };
const RESOLVED = { clientId: 'client_1', email: 'a@b.com', source: 'database' as const };
const CLIENT_PRODUCT = { id: 'cp_1', tenantId: 't1', product: { tier: 'team' } };

function makeRequest(body?: unknown) {
  return { json: async () => body ?? null } as unknown as NextRequest;
}

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.getSession.mockReset().mockResolvedValue(SESSION_OK);
  mockState.resolveClientFromSession.mockReset().mockResolvedValue(RESOLVED);
  mockState.clientProductFindFirst.mockReset().mockResolvedValue(CLIENT_PRODUCT);
  mockState.campaignFindUnique.mockReset().mockResolvedValue(null);
  mockState.campaignCreate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'camp_1', ...data }),
  );
  mockState.campaignUpdate.mockReset().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: 'camp_1', category: 'x', locationQuery: 'y', radiusMeters: 10000, ...data }),
  );
  mockState.campaignAuditCreate.mockReset();
  mockState.searchDeleteMany.mockReset().mockResolvedValue({ count: 0 });
  mockState.searchUpdate.mockReset().mockResolvedValue({});
  mockState.searchCreateMany.mockReset().mockResolvedValue({ count: 0 });
  mockState.logError.mockReset();
});

const VALID_BODY = { searches: [{ category: 'ferretería', locationQuery: 'Las Palmas de Gran Canaria' }] };

describe('PATCH /api/portal/prospecting/campaign', () => {
  it('401s without a client session', async () => {
    mockState.getSession.mockResolvedValue({ hasClientAccess: false });
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('400s on a malformed body', async () => {
    const res = await PATCH(makeRequest({ searches: 'no-es-una-lista' }));
    expect(res.status).toBe(400);
  });

  it('403s a client without the prospecting product', async () => {
    mockState.clientProductFindFirst.mockResolvedValue(null);
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockState.campaignCreate).not.toHaveBeenCalled();
  });

  it('creates a new campaign with the tier-derived monthlyLeadCap on first save', async () => {
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mockState.campaignCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clientId: 'client_1',
          clientProductId: 'cp_1',
          searches: { create: [{ category: 'ferretería', locationQuery: 'Las Palmas de Gran Canaria' }] },
          monthlyLeadCap: 300, // tier 'team'
        }),
      }),
    );
    expect(mockState.campaignAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'created', actorId: 'client:client_1' }) }),
    );
    expect(mockState.campaignUpdate).not.toHaveBeenCalled();
  });

  it('falls back to the solo cap for an unrecognised tier', async () => {
    mockState.clientProductFindFirst.mockResolvedValue({ ...CLIENT_PRODUCT, product: { tier: 'unknown_tier' } });
    await PATCH(makeRequest(VALID_BODY));
    expect(mockState.campaignCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ monthlyLeadCap: 100 }) }),
    );
  });

  it('updates the existing campaign on a subsequent save, never creates a second one', async () => {
    mockState.campaignFindUnique.mockResolvedValue({
      id: 'camp_1',
      presentacion: null,
      searches: [{ id: 's_1', category: 'panadería', locationQuery: 'Tenerife' }],
    });
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    expect(mockState.searchDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s_1'] }, campaignId: 'camp_1' } });
    expect(mockState.searchCreateMany).toHaveBeenCalledWith({
      data: [{ campaignId: 'camp_1', category: 'ferretería', locationQuery: 'Las Palmas de Gran Canaria' }],
    });
    expect(mockState.campaignUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'camp_1' } }));
    expect(mockState.campaignCreate).not.toHaveBeenCalled();
    expect(mockState.campaignAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'profile_updated',
          before: { searches: [{ category: 'panadería', locationQuery: 'Tenerife' }], presentacion: null },
          after: expect.objectContaining({
            searches: [{ category: 'ferretería', locationQuery: 'Las Palmas de Gran Canaria' }],
          }),
        }),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // 28/09/2026 — la presentación, el {{3}} del primer mensaje.
  // ---------------------------------------------------------------------------

  it('guarda la presentación ya normalizada, la misma que se enviaría', async () => {
    await PATCH(makeRequest({ ...VALID_BODY, presentacion: 'Nos dedicamos a las reformas de baños.' }));
    expect(mockState.campaignCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ presentacion: 'las reformas de baños' }) }),
    );
  });

  it('rechaza una presentación demasiado larga en vez de cortarla', async () => {
    const res = await PATCH(makeRequest({ ...VALID_BODY, presentacion: 'reformas '.repeat(12) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'presentacion_demasiado_larga', max: 80 });
    expect(mockState.campaignCreate).not.toHaveBeenCalled();
  });

  it('una presentación vaciada se guarda como null, no como «»', async () => {
    mockState.campaignFindUnique.mockResolvedValue({
      id: 'camp_1',
      searches: [{ id: 's_1', category: 'panadería', locationQuery: 'Tenerife' }],
      presentacion: 'pan de masa madre',
    });
    await PATCH(makeRequest({ ...VALID_BODY, presentacion: '  ' }));
    expect(mockState.campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ presentacion: null }) }),
    );
  });

  it('sin el campo en el cuerpo no toca la presentación guardada', async () => {
    mockState.campaignFindUnique.mockResolvedValue({
      id: 'camp_1',
      searches: [{ id: 's_1', category: 'panadería', locationQuery: 'Tenerife' }],
      presentacion: 'pan de masa madre',
    });
    await PATCH(makeRequest(VALID_BODY));
    const { data } = mockState.campaignUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).not.toHaveProperty('presentacion');
  });

  // Es texto que sale con el nombre del cliente hacia un desconocido: si
  // alguien pregunta quién escribió qué, la respuesta está en la auditoría.
  it('audita la presentación de antes y la de después', async () => {
    mockState.campaignFindUnique.mockResolvedValue({
      id: 'camp_1',
      searches: [{ id: 's_1', category: 'panadería', locationQuery: 'Tenerife' }],
      presentacion: 'pan de masa madre',
    });
    await PATCH(makeRequest({ ...VALID_BODY, presentacion: 'pan y bollería para hostelería' }));
    expect(mockState.campaignAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          before: expect.objectContaining({ presentacion: 'pan de masa madre' }),
          after: expect.objectContaining({ presentacion: 'pan y bollería para hostelería' }),
        }),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // 29/09/2026 — varias búsquedas.
  // ---------------------------------------------------------------------------

  it('guardar sin cambiar una búsqueda no la borra ni la recrea: conserva su lastRunAt', async () => {
    mockState.campaignFindUnique.mockResolvedValue({
      id: 'camp_1',
      presentacion: null,
      searches: [{ id: 's_1', category: 'ferretería', locationQuery: 'Las Palmas de Gran Canaria' }],
    });
    await PATCH(
      makeRequest({
        searches: [
          { category: 'ferretería', locationQuery: 'Las Palmas de Gran Canaria' },
          { category: 'pinturas', locationQuery: 'Telde' },
        ],
      }),
    );
    expect(mockState.searchDeleteMany).not.toHaveBeenCalled();
    expect(mockState.searchCreateMany).toHaveBeenCalledWith({
      data: [{ campaignId: 'camp_1', category: 'pinturas', locationQuery: 'Telde' }],
    });
  });

  it('quita las repetidas y las vacías antes de guardar', async () => {
    await PATCH(
      makeRequest({
        searches: [
          { category: 'ferretería', locationQuery: 'Telde' },
          { category: ' Ferretería ', locationQuery: 'telde' },
          { category: '', locationQuery: '' },
        ],
      }),
    );
    expect(mockState.campaignCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ searches: { create: [{ category: 'ferretería', locationQuery: 'Telde' }] } }),
      }),
    );
  });

  it('sin ninguna búsqueda completa, 400', async () => {
    const res = await PATCH(makeRequest({ searches: [{ category: 'ferretería', locationQuery: '  ' }] }));
    expect(res.status).toBe(400);
    expect(mockState.campaignCreate).not.toHaveBeenCalled();
  });

  it('más búsquedas de las permitidas: 400 con su propio código', async () => {
    const searches = Array.from({ length: 11 }, (_, i) => ({ category: `rubro ${i}`, locationQuery: 'Madrid' }));
    const res = await PATCH(makeRequest({ searches }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'demasiadas_busquedas', max: 10 });
  });

  // Una pestaña abierta con la versión anterior del portal durante el despliegue.
  it('sigue aceptando el formato de antes: un rubro y una zona sueltos', async () => {
    const res = await PATCH(makeRequest({ category: 'ferretería', locationQuery: 'Telde', radiusMeters: 15000 }));
    expect(res.status).toBe(200);
    expect(mockState.campaignCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ searches: { create: [{ category: 'ferretería', locationQuery: 'Telde' }] } }),
      }),
    );
  });

  it('500s cleanly and logs when the transaction throws', async () => {
    mockState.campaignCreate.mockRejectedValue(new Error('db down'));
    const res = await PATCH(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal_error' });
    expect(mockState.logError).toHaveBeenCalled();
  });
});
