// =============================================================================
// Producto Web, Fase 1 — unit tests de las rutas del CLIENTE sobre su web.
//
// Lo que se fija aquí es el aislamiento entre clientes, que es la frontera
// que más caro sale romper: el clientId sale SIEMPRE de la sesión y se cruza
// con el clientProductId de la URL. Sin ese cruce, cambiar un id en la barra
// del navegador editaría o publicaría la web de otro.
//
// Y lo segundo: que al cliente no se le enseñe el error crudo del servidor
// SFTP. "Permission denied" no le dice nada y le asusta; el detalle queda en
// la fila y en la auditoría, para el operador.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  resolveClient: vi.fn(),
  findFirst: vi.fn(),
  publish: vi.fn(),
  transaction: vi.fn(),
  update: vi.fn(),
  createAudit: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClient(...a),
}));
vi.mock('@/lib/website-publish', () => ({ publishWebsite: (...a: unknown[]) => mockState.publish(...a) }));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));
vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    clientWebsite: {
      findFirst: (...a: unknown[]) => mockState.findFirst(...a),
      update: (...a: unknown[]) => mockState.update(...a),
    },
    clientWebsiteAudit: { create: (...a: unknown[]) => mockState.createAudit(...a) },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      mockState.transaction(fn) ??
      fn({
        clientWebsite: { update: (...a: unknown[]) => mockState.update(...a) },
        clientWebsiteAudit: { create: (...a: unknown[]) => mockState.createAudit(...a) },
      }),
  },
}));

import { PATCH } from '@/app/api/portal/website/[clientProductId]/route';
import { POST as publishRoute } from '@/app/api/portal/website/[clientProductId]/publish/route';

const PARAMS = { params: { clientProductId: '22222222-2222-4222-8222-222222222222' } };
const COPY = { headline: 'Titular', subheadline: '', about: '', services: [], callToAction: '' };

function request(body?: unknown): Request {
  return new Request('https://portal.test/api/portal/website/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  mockState.resolveClient.mockReset().mockResolvedValue({ clientId: 'client-1', source: 'database' });
  mockState.findFirst.mockReset().mockResolvedValue({ id: 'w1', clientId: 'client-1', tenantId: null, copy: COPY, phone: null });
  mockState.publish.mockReset().mockResolvedValue({ ok: true });
  mockState.transaction.mockReset().mockReturnValue(undefined);
  mockState.update.mockReset().mockResolvedValue({});
  mockState.createAudit.mockReset().mockResolvedValue({});
  mockState.logError.mockReset();
});

describe('PATCH contenido (cliente)', () => {
  it('sin sesión no edita nada', async () => {
    mockState.resolveClient.mockResolvedValue(null);
    const res = await PATCH(request({ copy: COPY }) as never, PARAMS);
    expect(res.status).toBe(404);
    expect(mockState.update).not.toHaveBeenCalled();
  });

  it('busca el sitio por clientProductId Y clientId de la sesión', async () => {
    await PATCH(request({ copy: COPY }) as never, PARAMS);
    expect(mockState.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientProductId: PARAMS.params.clientProductId, clientId: 'client-1' },
      }),
    );
  });

  it('la web de otro cliente no aparece, y sin fila no se escribe', async () => {
    mockState.findFirst.mockResolvedValue(null);
    const res = await PATCH(request({ copy: COPY }) as never, PARAMS);
    expect(res.status).toBe(404);
    expect(mockState.update).not.toHaveBeenCalled();
  });

  it('un titular vacío se rechaza: la portada se quedaría sin nada', async () => {
    const res = await PATCH(request({ copy: { ...COPY, headline: '' } }) as never, PARAMS);
    expect(res.status).toBe(400);
  });

  it('la auditoría marca que escribió el cliente, no el operador', async () => {
    await PATCH(request({ copy: COPY }) as never, PARAMS);
    const audited = mockState.createAudit.mock.calls[0][0].data;
    expect(audited.actorType).toBe('client');
    expect(audited.actorEmail).toBe('client:client-1');
  });
});

describe('POST publicar (cliente)', () => {
  it('sin sesión no publica', async () => {
    mockState.resolveClient.mockResolvedValue(null);
    const res = await publishRoute(request() as never, PARAMS);
    expect(res.status).toBe(401);
    expect(mockState.publish).not.toHaveBeenCalled();
  });

  it('el cliente puede publicar lo suyo', async () => {
    const res = await publishRoute(request() as never, PARAMS);
    expect(res.status).toBe(200);
    expect(mockState.publish).toHaveBeenCalled();
  });

  it('no puede publicar la web de otro', async () => {
    mockState.findFirst.mockResolvedValue(null);
    const res = await publishRoute(request() as never, PARAMS);
    expect(res.status).toBe(404);
    expect(mockState.publish).not.toHaveBeenCalled();
  });

  it('el error crudo del SFTP no llega al cliente', async () => {
    mockState.publish.mockResolvedValue({ ok: false, error: 'Permission denied (publickey,password)' });
    const res = await publishRoute(request() as never, PARAMS);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: 'publish_failed' });
    expect(JSON.stringify(body)).not.toContain('Permission denied');
  });

  it('sin credencial guardada el mensaje es otro: el remedio es nuestro, no suyo', async () => {
    mockState.publish.mockResolvedValue({ ok: false, error: 'credential_missing' });
    const res = await publishRoute(request() as never, PARAMS);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'publish_not_configured' });
  });
});
