// PUT /api/admin/portal/clients/[id]/web-origins — el operador edita las webs
// desde las que funciona el widget del chat de un cliente (21/11/2026).
// Misma validación y guardado que la ruta del cliente (lib/web-widget-origin.ts,
// sin mockear); aquí se comprueba lo propio: sesión de operador, el chatbot
// correcto y que la auditoría la firma el operador.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  embedFindMany: vi.fn(),
  embedUpdate: vi.fn(),
  auditCreate: vi.fn(),
  operatorFindUnique: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...a: unknown[]) => m.auth(...a),
}));
vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    chatWebEmbed: {
      findMany: (...a: unknown[]) => m.embedFindMany(...a),
      update: (...a: unknown[]) => m.embedUpdate(...a),
    },
    chatWebEmbedAudit: { create: (...a: unknown[]) => m.auditCreate(...a) },
    operator: { findUnique: (...a: unknown[]) => m.operatorFindUnique(...a) },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import { PUT } from '@/app/api/admin/portal/clients/[id]/web-origins/route';

const CP = '33333333-3333-4333-8333-333333333333';
const EMBED = { id: 'emb_1', clientId: 'cli_1', tenantId: 't_1', allowedOrigins: [] as string[] };

function call(body: unknown, query = `?clientProductId=${CP}`) {
  const req = new NextRequest(`http://portal.test/api/admin/portal/clients/cli_1/web-origins${query}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return PUT(req, { params: Promise.resolve({ id: 'cli_1' }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ ok: true, sessionId: 's_1', operatorId: 'op_1' });
  m.embedFindMany.mockResolvedValue([EMBED]);
  m.embedUpdate.mockResolvedValue({});
  m.auditCreate.mockResolvedValue({});
  m.operatorFindUnique.mockResolvedValue({ email: 'ops@kairikos.test' });
});

describe('PUT /api/admin/portal/clients/[id]/web-origins', () => {
  it('sin sesión de operador: 401 y no toca nada', async () => {
    m.auth.mockResolvedValue({ ok: false });
    const res = await call({ allowedOrigins: ['https://x.com'] });
    expect(res.status).toBe(401);
    expect(m.embedFindMany).not.toHaveBeenCalled();
    expect(m.embedUpdate).not.toHaveBeenCalled();
  });

  it('guarda la lista normalizada y la auditoría la firma el operador', async () => {
    const res = await call({ allowedOrigins: ['www.negocio.com/contacto', '', 'http://localhost:4321'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changed: true, allowedOrigins: ['https://www.negocio.com', 'http://localhost:4321'] });
    expect(m.embedFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { clientId: 'cli_1', clientProductId: CP } }));
    expect(m.embedUpdate).toHaveBeenCalledWith({ where: { id: 'emb_1' }, data: { allowedOrigins: ['https://www.negocio.com', 'http://localhost:4321'] } });
    expect(m.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        embedId: 'emb_1',
        clientId: 'cli_1',
        action: 'allowed_origins_updated',
        actorType: 'operator',
        actorOperatorId: 'op_1',
        actorEmail: 'ops@kairikos.test',
        before: { allowedOrigins: [] },
      }),
    });
  });

  it('una web no válida rechaza la lista entera y dice cuál', async () => {
    const res = await call({ allowedOrigins: ['https://bien.com', 'ftp://mal.example'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_origin', value: 'ftp://mal.example' });
    expect(m.embedUpdate).not.toHaveBeenCalled();
  });

  it('con varios widgets y sin decir el chatbot: 409', async () => {
    m.embedFindMany.mockResolvedValue([EMBED, { ...EMBED, id: 'emb_2' }]);
    const res = await call({ allowedOrigins: [] }, '');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'chatbot_not_specified' });
  });

  it('sin widget: 404', async () => {
    m.embedFindMany.mockResolvedValue([]);
    const res = await call({ allowedOrigins: [] });
    expect(res.status).toBe(404);
  });

  it('la misma lista no escribe ni audita', async () => {
    m.embedFindMany.mockResolvedValue([{ ...EMBED, allowedOrigins: ['https://x.com'] }]);
    const res = await call({ allowedOrigins: ['x.com'] });
    expect(await res.json()).toEqual({ ok: true, changed: false, allowedOrigins: ['https://x.com'] });
    expect(m.embedUpdate).not.toHaveBeenCalled();
    expect(m.auditCreate).not.toHaveBeenCalled();
  });
});
