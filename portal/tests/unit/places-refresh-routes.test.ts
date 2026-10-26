// =============================================================================
// 26/10/2026 — las rutas de «Actualizar desde Google» (lib/places-retention.ts).
//
// Lo que se fija aquí es la frontera entre clientes: en el portal el cliente
// sale SIEMPRE de la sesión y viaja a la librería como comprobación de
// propiedad; nada de la petición la cambia. Y que el operador entra por su
// propia autenticación, sin cliente.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  session: vi.fn(),
  resolveClient: vi.fn(),
  adminAuth: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: (...a: unknown[]) => mockState.session(...a) }));
vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClient(...a),
}));
vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.adminAuth(...a),
}));
vi.mock('@/lib/prisma', () => ({ isDatabaseConfigured: true, prisma: {} }));
vi.mock('@/lib/places-retention', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/places-retention')>();
  return { ...actual, refreshLeadPlacesData: (...a: unknown[]) => mockState.refresh(...a) };
});

import { POST as clientRoute } from '@/app/api/portal/leads/[id]/actualizar-google/route';
import { POST as adminRoute } from '@/app/api/admin/portal/leads/[id]/actualizar-google/route';

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  mockState.session.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.resolveClient.mockReset().mockResolvedValue({ clientId: 'cliente-sesion', source: 'database' });
  mockState.adminAuth.mockReset().mockResolvedValue({ ok: true, operatorId: 'op-1', sessionId: 's' });
  mockState.refresh.mockReset().mockResolvedValue({ ok: true, fields: {}, fromCache: false });
});

describe('POST /api/portal/leads/[id]/actualizar-google', () => {
  it('el cliente sale de la sesión, aunque la petición traiga otro', async () => {
    const req = new Request('https://portal.test/x?clientId=otro', {
      method: 'POST',
      body: JSON.stringify({ clientId: 'otro' }),
    });
    const res = await clientRoute(req, params('lead-1'));
    expect(res.status).toBe(200);
    expect(mockState.refresh.mock.calls[0][1]).toEqual({
      leadId: 'lead-1',
      clientId: 'cliente-sesion',
      actorId: 'client:cliente-sesion',
    });
  });

  it('sin sesión de cliente, 401 y no se llama a Google', async () => {
    mockState.session.mockResolvedValue({ hasClientAccess: false });
    const res = await clientRoute(new Request('https://portal.test/x', { method: 'POST' }), params('lead-1'));
    expect(res.status).toBe(401);
    expect(mockState.refresh).not.toHaveBeenCalled();
  });

  it('un lead de otro cliente es 404, y el tope 429 con su mensaje', async () => {
    mockState.refresh.mockResolvedValueOnce({ ok: false, reason: 'lead_not_found' });
    expect((await clientRoute(new Request('https://portal.test/x', { method: 'POST' }), params('ajeno'))).status).toBe(404);

    mockState.refresh.mockResolvedValueOnce({ ok: false, reason: 'client_cap' });
    const res = await clientRoute(new Request('https://portal.test/x', { method: 'POST' }), params('lead-1'));
    expect(res.status).toBe(429);
    expect((await res.json()).message).toContain('tope');
  });

  it('«Google ya no lo encuentra» llega como 409 con el motivo', async () => {
    mockState.refresh.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    const res = await clientRoute(new Request('https://portal.test/x', { method: 'POST' }), params('lead-1'));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('not_found');
    expect(body.message).toContain('ya no encuentra');
  });
});

describe('POST /api/admin/portal/leads/[id]/actualizar-google', () => {
  it('con sesión de operador, sin filtro de cliente y firmado por el operador', async () => {
    const res = await adminRoute({} as NextRequest, params('lead-1'));
    expect(res.status).toBe(200);
    expect(mockState.refresh.mock.calls[0][1]).toEqual({ leadId: 'lead-1', actorId: 'op-1' });
  });

  it('sin sesión de operador, 401', async () => {
    mockState.adminAuth.mockResolvedValue({ ok: false });
    expect((await adminRoute({} as NextRequest, params('lead-1'))).status).toBe(401);
    expect(mockState.refresh).not.toHaveBeenCalled();
  });
});
