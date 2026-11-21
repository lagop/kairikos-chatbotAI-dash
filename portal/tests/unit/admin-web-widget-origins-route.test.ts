// =============================================================================
// PUT /api/admin/portal/clients/[id]/web-widget-origins (21/11/2026) — el
// operador edita las webs desde las que contesta el widget de un cliente. El
// lib (normalizar, validar, transacción con auditoría) ya lo prueba
// web-widget-origin.test.ts; aquí, lo propio de la ruta de admin: la sesión
// de operador, el cliente de la URL y la auditoría a nombre del operador.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  embedFindMany: vi.fn(),
  embedUpdate: vi.fn(),
  auditCreate: vi.fn(),
  operatorFindUnique: vi.fn(),
  transaction: vi.fn(),
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => mockState.authenticateAdminRequest(...a),
}));
vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    chatWebEmbed: {
      findMany: (...a: unknown[]) => mockState.embedFindMany(...a),
      update: (...a: unknown[]) => mockState.embedUpdate(...a),
    },
    chatWebEmbedAudit: { create: (...a: unknown[]) => mockState.auditCreate(...a) },
    operator: { findUnique: (...a: unknown[]) => mockState.operatorFindUnique(...a) },
    $transaction: (...a: unknown[]) => mockState.transaction(...a),
  },
}));

const OPERATOR_ID = '11111111-1111-4111-8111-111111111111';
const EMBED = {
  id: 'embed_1',
  clientId: 'client_9',
  clientProductId: 'cp_1',
  tenantId: 'tenant_1',
  publicToken: 'wgt_1',
  status: 'active',
  allowedOrigins: [] as string[],
};

async function put(body: unknown, query = '', clientId = 'client_9'): Promise<Response> {
  const url = new URL(`https://portal.kairikos.test/api/admin/portal/clients/${clientId}/web-widget-origins${query}`);
  const req = { json: async () => body, url: url.toString(), nextUrl: url } as unknown as NextRequest;
  const { PUT } = await import('@/app/api/admin/portal/clients/[id]/web-widget-origins/route');
  return PUT(req, { params: Promise.resolve({ id: clientId }) });
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, sessionId: 's1', operatorId: OPERATOR_ID });
  mockState.embedFindMany.mockReset().mockResolvedValue([EMBED]);
  mockState.embedUpdate.mockReset().mockResolvedValue({});
  mockState.auditCreate.mockReset().mockResolvedValue({});
  mockState.operatorFindUnique.mockReset().mockResolvedValue({ email: 'ops@kairikos.example' });
  mockState.transaction.mockReset().mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  mockState.isDatabaseConfigured = true;
});

describe('PUT /api/admin/portal/clients/[id]/web-widget-origins', () => {
  it('401 sin sesión de operador, sin tocar nada', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    expect((await put({ allowedOrigins: ['a.example'] })).status).toBe(401);
    expect(mockState.embedFindMany).not.toHaveBeenCalled();
    expect(mockState.transaction).not.toHaveBeenCalled();
  });

  it('guarda la lista del cliente de la URL, normalizada, con la auditoría a nombre del operador', async () => {
    const res = await put({ allowedOrigins: ['signature-demo.kairikos.cloud', 'http://localhost:4321/'] });
    const origins = ['https://signature-demo.kairikos.cloud', 'http://localhost:4321'];
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, allowedOrigins: origins, changed: true });

    expect(mockState.embedFindMany.mock.calls[0][0].where).toEqual({ clientId: 'client_9' });
    expect(mockState.embedUpdate).toHaveBeenCalledWith({ where: { id: 'embed_1' }, data: { allowedOrigins: origins } });
    expect(mockState.auditCreate.mock.calls[0][0].data).toMatchObject({
      embedId: 'embed_1',
      clientId: 'client_9',
      action: 'allowed_origins_updated',
      before: { allowedOrigins: [] },
      after: { allowedOrigins: origins },
      actorType: 'operator',
      actorOperatorId: OPERATOR_ID,
      actorEmail: 'ops@kairikos.example',
    });
  });

  it('con varios chatbots, ?clientProductId elige el widget; sin él, 409', async () => {
    mockState.embedFindMany.mockResolvedValue([EMBED, { ...EMBED, id: 'embed_2', clientProductId: 'cp_2' }]);
    expect((await put({ allowedOrigins: [] })).status).toBe(409);

    mockState.embedFindMany.mockResolvedValue([EMBED]);
    await put({ allowedOrigins: ['a.example'] }, '?clientProductId=cp_1');
    expect(mockState.embedFindMany.mock.calls.at(-1)![0].where).toEqual({ clientId: 'client_9', clientProductId: 'cp_1' });
  });

  it('404 si el cliente no tiene widget web', async () => {
    mockState.embedFindMany.mockResolvedValue([]);
    expect((await put({ allowedOrigins: [] })).status).toBe(404);
  });

  it('400 con una web inválida, diciendo cuál, sin escribir', async () => {
    const res = await put({ allowedOrigins: ['ftp://archivos.example'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_origin', value: 'ftp://archivos.example' });
    expect(mockState.transaction).not.toHaveBeenCalled();
  });

  it('400 con un cuerpo que no es una lista', async () => {
    expect((await put({ allowedOrigins: 'a.example' })).status).toBe(400);
    expect((await put(null)).status).toBe(400);
  });

  it('sin cambios no escribe ni deja auditoría', async () => {
    mockState.embedFindMany.mockResolvedValue([{ ...EMBED, allowedOrigins: ['https://a.example'] }]);
    expect(await (await put({ allowedOrigins: ['a.example'] })).json()).toMatchObject({ changed: false });
    expect(mockState.transaction).not.toHaveBeenCalled();
  });

  it('si el operador ya no existe, la auditoría guarda su id igualmente', async () => {
    mockState.operatorFindUnique.mockResolvedValue(null);
    await put({ allowedOrigins: ['a.example'] });
    expect(mockState.auditCreate.mock.calls[0][0].data).toMatchObject({
      actorOperatorId: OPERATOR_ID,
      actorEmail: `operator:${OPERATOR_ID}`,
    });
  });
});
