// =============================================================================
// POST /api/admin/portal/recall/[subscriptionId]/meta-manual
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  requireTotpStepUp: vi.fn(),
  connectRecallWhatsappManually: vi.fn(),
  operatorFindUnique: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: { operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) } },
}));
vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));
vi.mock('@/lib/operator-totp-stepup', () => ({
  requireTotpStepUp: (...a: unknown[]) => mockState.requireTotpStepUp(...a),
}));
vi.mock('@/lib/recall-meta', () => ({
  connectRecallWhatsappManually: (...a: unknown[]) => mockState.connectRecallWhatsappManually(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import { POST } from '@/app/api/admin/portal/recall/[subscriptionId]/meta-manual/route';

const SUB = '33333333-3333-3333-3333-333333333333';
const TOKEN = 'EAAG-secret-system-user-token-123456';
const BODY = { wabaId: '111111111111111', phoneNumberId: '222222222222222', accessToken: TOKEN };
const ctx = { params: { subscriptionId: SUB } };
const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.authenticateAdminRequest.mockResolvedValue({ ok: true, sessionId: 's1', operatorId: 'op_1' });
  mockState.requireTotpStepUp.mockResolvedValue({ ok: true, operatorId: 'op_1', sessionId: 's1' });
  mockState.operatorFindUnique.mockResolvedValue({ email: 'op@kairikos.com' });
  mockState.connectRecallWhatsappManually.mockResolvedValue({
    ok: true,
    connectionId: 'conn_1',
    displayPhoneNumber: '+34 600 000 000',
    advancedTo: null,
    templatesSubmitted: null,
  });
});

describe('POST meta-manual', () => {
  it('401 sin sesión y 403 con la clave heredada', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    expect((await POST(req(BODY), ctx)).status).toBe(401);
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: true, sessionId: null, operatorId: 'legacy' });
    expect((await POST(req(BODY), ctx)).status).toBe(403);
    expect(mockState.connectRecallWhatsappManually).not.toHaveBeenCalled();
  });

  it('exige TOTP: guarda un token con el que se envían mensajes', async () => {
    mockState.requireTotpStepUp.mockResolvedValue({ ok: false, status: 403, error: 'totp_step_up_required' });
    const res = await POST(req(BODY), ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'totp_step_up_required' });
    expect(mockState.connectRecallWhatsappManually).not.toHaveBeenCalled();
  });

  it('un cuerpo inválido no devuelve detalles (llevaría el token)', async () => {
    const res = await POST(req({ ...BODY, wabaId: 'abc' }), ctx);
    expect(res.status).toBe(400);
    const text = JSON.stringify(await res.json());
    expect(text).toBe('{"error":"invalid_body"}');
  });

  it('conecta, atribuye al operador y nunca devuelve el token', async () => {
    const res = await POST(req(BODY), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(body).toEqual({ ok: true, connectionId: 'conn_1', displayPhoneNumber: '+34 600 000 000', advancedTo: null });
    expect(mockState.connectRecallWhatsappManually).toHaveBeenCalledWith(expect.anything(), {
      subscriptionId: SUB,
      wabaId: BODY.wabaId,
      phoneNumberId: BODY.phoneNumberId,
      accessToken: TOKEN,
      operator: { operatorId: 'op_1', email: 'op@kairikos.com' },
    });
  });

  it('traduce los errores de validación con su detalle', async () => {
    mockState.connectRecallWhatsappManually.mockResolvedValue({
      ok: false,
      error: 'missing_permissions',
      detail: 'whatsapp_business_messaging',
    });
    const res = await POST(req(BODY), ctx);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_permissions', detail: 'whatsapp_business_messaging' });
  });

  it('500 sin filtrar el token si algo lanza', async () => {
    mockState.connectRecallWhatsappManually.mockRejectedValue(new Error('db down'));
    const res = await POST(req(BODY), ctx);
    expect(res.status).toBe(500);
    expect(JSON.stringify(mockState.logError.mock.calls)).not.toContain(TOKEN);
  });
});
