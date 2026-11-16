// =============================================================================
// Dominios permitidos del widget web (16/11/2026): el lib que normaliza y
// comprueba los orígenes, y la ruta del portal que guarda la lista con su
// auditoría. Las comprobaciones en las rutas públicas (config, message,
// contact) están en los tests de cada ruta.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import {
  isWidgetOriginAllowed,
  normalizeOrigin,
  parseAllowedOrigins,
  requestOrigin,
  MAX_ALLOWED_ORIGINS,
} from '@/lib/web-widget-origin';

const h = (init: Record<string, string> = {}) => new Headers(init);

describe('normalizeOrigin', () => {
  it('lo que escribe una persona se queda en el origen', () => {
    expect(normalizeOrigin('www.clinica.example')).toBe('https://www.clinica.example');
    expect(normalizeOrigin('  https://clinica.example/contacto?x=1#a ')).toBe('https://clinica.example');
    expect(normalizeOrigin('HTTPS://Clinica.Example')).toBe('https://clinica.example');
    expect(normalizeOrigin('http://localhost:4321')).toBe('http://localhost:4321');
    expect(normalizeOrigin('https://signature-demo.kairikos.cloud/')).toBe('https://signature-demo.kairikos.cloud');
  });

  it('el puerto por defecto desaparece, como en la cabecera Origin del navegador', () => {
    expect(normalizeOrigin('https://clinica.example:443')).toBe('https://clinica.example');
  });

  it('rechaza otros esquemas en vez de anteponerles https (la trampa de ftp://)', () => {
    expect(normalizeOrigin('ftp://archivos.example')).toBeNull();
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull();
  });

  it('rechaza hosts sin punto (salvo localhost), credenciales y basura', () => {
    expect(normalizeOrigin('intranet')).toBeNull();
    expect(normalizeOrigin('https://user:pass@clinica.example')).toBeNull();
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin('no es una web')).toBeNull();
    expect(normalizeOrigin('https://' + 'a'.repeat(300) + '.example')).toBeNull();
  });
});

describe('parseAllowedOrigins', () => {
  it('normaliza, quita repetidos y líneas vacías', () => {
    expect(parseAllowedOrigins(['www.a.example', '', '  ', 'https://www.a.example/x', 'b.example'])).toEqual({
      ok: true,
      origins: ['https://www.a.example', 'https://b.example'],
    });
  });

  it('una lista vacía es válida (sin restricción)', () => {
    expect(parseAllowedOrigins([])).toEqual({ ok: true, origins: [] });
  });

  it('una entrada mala rechaza la lista entera y dice cuál', () => {
    expect(parseAllowedOrigins(['a.example', ' ftp://b.example '])).toEqual({
      ok: false,
      error: 'invalid_origin',
      value: 'ftp://b.example',
    });
  });

  it(`como mucho ${MAX_ALLOWED_ORIGINS}, contadas después de quitar repetidos`, () => {
    const diez = Array.from({ length: MAX_ALLOWED_ORIGINS }, (_, i) => `w${i}.example`);
    expect(parseAllowedOrigins([...diez, 'w0.example']).ok).toBe(true);
    expect(parseAllowedOrigins([...diez, 'otra.example'])).toEqual({ ok: false, error: 'too_many_origins' });
  });
});

describe('requestOrigin', () => {
  it('usa Origin, y si falta, el origen del Referer', () => {
    expect(requestOrigin(h({ origin: 'https://a.example' }))).toBe('https://a.example');
    expect(requestOrigin(h({ referer: 'https://a.example/pagina?q=1' }))).toBe('https://a.example');
    expect(requestOrigin(h({ origin: 'https://a.example', referer: 'https://b.example/' }))).toBe('https://a.example');
  });

  it('Origin: null, un Referer que no es http(s) o nada: sin origen', () => {
    expect(requestOrigin(h({ origin: 'null' }))).toBeNull();
    expect(requestOrigin(h({ referer: 'android-app://com.x/' }))).toBeNull();
    expect(requestOrigin(h())).toBeNull();
  });
});

describe('isWidgetOriginAllowed', () => {
  const lista = ['https://www.clinica.example', 'http://localhost:4321'];

  it('lista vacía o ausente: siempre, incluso sin Origin', () => {
    expect(isWidgetOriginAllowed([], h())).toBe(true);
    expect(isWidgetOriginAllowed(undefined, h({ origin: 'https://cualquiera.example' }))).toBe(true);
    expect(isWidgetOriginAllowed(null, h())).toBe(true);
  });

  it('origen permitido: sí', () => {
    expect(isWidgetOriginAllowed(lista, h({ origin: 'https://www.clinica.example' }))).toBe(true);
    expect(isWidgetOriginAllowed(lista, h({ origin: 'http://localhost:4321' }))).toBe(true);
  });

  it('origen no permitido: no (ni el mismo host con otro esquema o puerto, ni un subdominio)', () => {
    expect(isWidgetOriginAllowed(lista, h({ origin: 'https://copion.example' }))).toBe(false);
    expect(isWidgetOriginAllowed(lista, h({ origin: 'http://www.clinica.example' }))).toBe(false);
    expect(isWidgetOriginAllowed(lista, h({ origin: 'http://localhost:3000' }))).toBe(false);
    expect(isWidgetOriginAllowed(lista, h({ origin: 'https://clinica.example' }))).toBe(false);
    expect(isWidgetOriginAllowed(lista, h({ origin: 'https://www.clinica.example.evil.example' }))).toBe(false);
  });

  it('sin cabecera Origin (ni Referer) y con lista: no', () => {
    expect(isWidgetOriginAllowed(lista, h())).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// PUT /api/portal/channels/web/origins
// -----------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  embedFindMany: vi.fn(),
  embedUpdate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/session', () => ({ getSession: (...a: unknown[]) => mockState.getSession(...a) }));
vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClientFromSession(...a),
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
    $transaction: (...a: unknown[]) => mockState.transaction(...a),
  },
}));

const EMBED = {
  id: 'embed_1',
  clientId: 'client_1',
  clientProductId: 'cp_1',
  tenantId: 'tenant_1',
  publicToken: 'wgt_1',
  status: 'active',
  allowedOrigins: [] as string[],
};

async function put(body: unknown): Promise<Response> {
  const url = new URL('https://portal.kairikos.test/api/portal/channels/web/origins');
  const req = { json: async () => body, url: url.toString(), nextUrl: url } as unknown as NextRequest;
  const { PUT } = await import('@/app/api/portal/channels/web/origins/route');
  return PUT(req);
}

beforeEach(() => {
  mockState.getSession.mockReset().mockResolvedValue({ hasClientAccess: true });
  mockState.resolveClientFromSession.mockReset().mockResolvedValue({ clientId: 'client_1', email: 'a@b.example' });
  mockState.embedFindMany.mockReset().mockResolvedValue([EMBED]);
  mockState.embedUpdate.mockReset().mockResolvedValue({});
  mockState.auditCreate.mockReset().mockResolvedValue({});
  mockState.transaction.mockReset().mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  mockState.isDatabaseConfigured = true;
});

describe('PUT /api/portal/channels/web/origins', () => {
  it('401 sin sesión de cliente', async () => {
    mockState.getSession.mockResolvedValue({ hasClientAccess: false });
    expect((await put({ allowedOrigins: [] })).status).toBe(401);
    expect(mockState.transaction).not.toHaveBeenCalled();
  });

  it('guarda la lista normalizada y deja auditoría en la misma transacción', async () => {
    const res = await put({ allowedOrigins: ['signature-demo.kairikos.cloud/', 'http://localhost:4321'] });
    expect(res.status).toBe(200);
    const origins = ['https://signature-demo.kairikos.cloud', 'http://localhost:4321'];
    expect(await res.json()).toEqual({ ok: true, allowedOrigins: origins, changed: true });

    expect(mockState.transaction).toHaveBeenCalledTimes(1);
    expect(mockState.embedUpdate).toHaveBeenCalledWith({ where: { id: 'embed_1' }, data: { allowedOrigins: origins } });
    expect(mockState.auditCreate).toHaveBeenCalledWith({
      data: {
        embedId: 'embed_1',
        clientId: 'client_1',
        tenantId: 'tenant_1',
        action: 'allowed_origins_updated',
        before: { allowedOrigins: [] },
        after: { allowedOrigins: origins },
        actorType: 'client',
        actorOperatorId: null,
        actorEmail: 'client:client_1',
      },
    });
  });

  it('vaciar la lista también se audita (es quitar la restricción)', async () => {
    mockState.embedFindMany.mockResolvedValue([{ ...EMBED, allowedOrigins: ['https://a.example'] }]);
    const res = await put({ allowedOrigins: [''] });
    expect(await res.json()).toMatchObject({ allowedOrigins: [], changed: true });
    expect(mockState.auditCreate.mock.calls[0][0].data).toMatchObject({
      before: { allowedOrigins: ['https://a.example'] },
      after: { allowedOrigins: [] },
    });
  });

  it('sin cambios no escribe nada ni deja auditoría', async () => {
    mockState.embedFindMany.mockResolvedValue([{ ...EMBED, allowedOrigins: ['https://a.example'] }]);
    const res = await put({ allowedOrigins: ['a.example'] });
    expect(await res.json()).toMatchObject({ changed: false });
    expect(mockState.transaction).not.toHaveBeenCalled();
  });

  it('400 con una web inválida, diciendo cuál, sin escribir', async () => {
    const res = await put({ allowedOrigins: ['a.example', 'ftp://b.example'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_origin', value: 'ftp://b.example' });
    expect(mockState.transaction).not.toHaveBeenCalled();
  });

  it('400 con más webs de la cuenta o un cuerpo que no es una lista', async () => {
    const once = Array.from({ length: MAX_ALLOWED_ORIGINS + 1 }, (_, i) => `w${i}.example`);
    expect(await (await put({ allowedOrigins: once })).json()).toEqual({ error: 'too_many_origins', value: null });
    expect((await put({ allowedOrigins: 'a.example' })).status).toBe(400);
    expect((await put(null)).status).toBe(400);
  });

  it('404 si el cliente no tiene widget; 409 si tiene varios chatbots y no dice cuál', async () => {
    mockState.embedFindMany.mockResolvedValue([]);
    expect((await put({ allowedOrigins: [] })).status).toBe(404);
    mockState.embedFindMany.mockResolvedValue([EMBED, { ...EMBED, id: 'embed_2', clientProductId: 'cp_2' }]);
    expect((await put({ allowedOrigins: [] })).status).toBe(409);
  });

  it('el widget se busca por el cliente de la sesión, nunca por algo del cuerpo', async () => {
    await put({ allowedOrigins: [], clientId: 'otro_cliente' });
    expect(mockState.embedFindMany.mock.calls[0][0].where).toMatchObject({ clientId: 'client_1' });
  });
});
