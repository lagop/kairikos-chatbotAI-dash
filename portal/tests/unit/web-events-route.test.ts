// =============================================================================
// Informe mensual de resultados — la ruta pública de eventos de la web
// Premium (/api/public/web-events/[token], docs/informe-mensual-web.md).
//
// Siempre 204, cuente o no. Lo que se comprueba es CUÁNDO cuenta: tipo
// válido, cuerpo pequeño, origen de la web del cliente, sin bots, dentro del
// límite. Y que el origen solo se guarda en 'landing'.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  siteFindFirst: vi.fn(),
  executeRaw: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    clientSite: { findFirst: (...a: unknown[]) => state.siteFindFirst(...a) },
    $executeRaw: (...a: unknown[]) => state.executeRaw(...a),
  },
}));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { OPTIONS, POST } from '@/app/api/public/web-events/[token]/route';
import {
  generateEventsToken,
  isEventsTokenShape,
  originMatchesSite,
  parseWebEvent,
} from '@/lib/web-events-rules';

const TOKEN = 'wev_abcdefghijklmnopqrstuvwxyz012345';
const SITE_ID = '11111111-1111-4111-8111-111111111111';
let ipCounter = 0;

function post(
  body: string,
  opts: { token?: string; headers?: Record<string, string>; ip?: string } = {},
) {
  const token = opts.token ?? TOKEN;
  // Una IP distinta por prueba: el limitador es estado del módulo.
  const ip = opts.ip ?? `10.0.0.${++ipCounter}`;
  const req = new NextRequest(`http://localhost/api/public/web-events/${token}`, {
    method: 'POST',
    body,
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      origin: 'https://www.clinica.example',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      'x-real-ip': ip,
      ...opts.headers,
    },
  });
  return POST(req, { params: Promise.resolve({ token }) });
}

/** Los valores interpolados del $executeRaw: [siteId, day, kind, source]. */
function lastUpsertValues(): unknown[] {
  const call = state.executeRaw.mock.calls.at(-1);
  return call ? call.slice(1) : [];
}

beforeEach(() => {
  state.siteFindFirst.mockReset();
  state.executeRaw.mockReset();
  state.siteFindFirst.mockResolvedValue({ id: SITE_ID, siteUrl: 'https://clinica.example' });
  state.executeRaw.mockResolvedValue(1);
});

describe('POST /api/public/web-events/[token]', () => {
  it('cuenta un landing válido con un único upsert y responde 204 con CORS', async () => {
    const res = await post('{"k":"landing","s":"ai"}');
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(state.executeRaw).toHaveBeenCalledTimes(1);
    const [siteId, day, kind, source] = lastUpsertValues();
    expect(siteId).toBe(SITE_ID);
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(kind).toBe('landing');
    expect(source).toBe('ai');
    const sql = (state.executeRaw.mock.calls[0][0] as string[]).join('?');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('"count" = "web_event_day"."count" + 1');
  });

  it('fuerza el origen vacío en todo lo que no es landing', async () => {
    await post('{"k":"whatsapp_click","s":"ai"}');
    const [, , kind, source] = lastUpsertValues();
    expect(kind).toBe('whatsapp_click');
    expect(source).toBe('');
  });

  it('acepta application/json además de text/plain', async () => {
    const res = await post('{"k":"form_submit"}', { headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(204);
    expect(state.executeRaw).toHaveBeenCalledTimes(1);
  });

  it('no cuenta un tipo desconocido', async () => {
    const res = await post('{"k":"purchase"}');
    expect(res.status).toBe(204);
    expect(state.executeRaw).not.toHaveBeenCalled();
  });

  it('no cuenta un cuerpo que no es JSON', async () => {
    await post('k=landing');
    expect(state.executeRaw).not.toHaveBeenCalled();
  });

  it('no cuenta un cuerpo de más de 512 bytes', async () => {
    const res = await post(JSON.stringify({ k: 'landing', s: 'ai', pad: 'x'.repeat(600) }));
    expect(res.status).toBe(204);
    expect(state.executeRaw).not.toHaveBeenCalled();
    expect(state.siteFindFirst).not.toHaveBeenCalled();
  });

  it('no cuenta si el origen no es la web del cliente', async () => {
    const res = await post('{"k":"call_click"}', { headers: { origin: 'https://otra-web.example' } });
    expect(res.status).toBe(204);
    expect(state.executeRaw).not.toHaveBeenCalled();
  });

  it('no cuenta sin Origin ni Referer cuando el sitio declara su web', async () => {
    const req = new NextRequest(`http://localhost/api/public/web-events/${TOKEN}`, {
      method: 'POST',
      body: '{"k":"call_click"}',
      headers: { 'content-type': 'text/plain', 'x-real-ip': '10.9.9.9' },
    });
    await POST(req, { params: Promise.resolve({ token: TOKEN }) });
    expect(state.executeRaw).not.toHaveBeenCalled();
  });

  it('usa el Referer si falta el Origin, y admite subdominios', async () => {
    await post('{"k":"call_click"}', { headers: { origin: '', referer: 'https://en.clinica.example/treatments' } });
    expect(state.executeRaw).toHaveBeenCalledTimes(1);
  });

  it('sin siteUrl en el sitio, cuenta venga de donde venga', async () => {
    state.siteFindFirst.mockResolvedValue({ id: SITE_ID, siteUrl: null });
    await post('{"k":"call_click"}', { headers: { origin: 'https://cualquiera.example' } });
    expect(state.executeRaw).toHaveBeenCalledTimes(1);
  });

  it('no cuenta bots por el user agent', async () => {
    await post('{"k":"landing","s":"search"}', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });
    await post('{"k":"landing","s":"search"}', { headers: { 'user-agent': 'Mozilla/5.0 HeadlessChrome/120.0' } });
    expect(state.executeRaw).not.toHaveBeenCalled();
  });

  it('token desconocido: 204 igual, sin escribir', async () => {
    state.siteFindFirst.mockResolvedValue(null);
    const res = await post('{"k":"landing","s":"direct"}');
    expect(res.status).toBe(204);
    expect(state.executeRaw).not.toHaveBeenCalled();
  });

  it('token con forma inválida: ni consulta la base de datos', async () => {
    const res = await post('{"k":"landing"}', { token: 'vil_abc' });
    expect(res.status).toBe(204);
    expect(state.siteFindFirst).not.toHaveBeenCalled();
  });

  it('corta a los 60 eventos por minuto de una misma IP y token', async () => {
    for (let i = 0; i < 60; i++) await post('{"k":"landing","s":"direct"}', { ip: '10.1.1.1' });
    expect(state.executeRaw).toHaveBeenCalledTimes(60);
    await post('{"k":"landing","s":"direct"}', { ip: '10.1.1.1' });
    expect(state.executeRaw).toHaveBeenCalledTimes(60);
    // Otra IP sigue contando.
    await post('{"k":"landing","s":"direct"}', { ip: '10.1.1.2' });
    expect(state.executeRaw).toHaveBeenCalledTimes(61);
  });

  it('si la base de datos falla, responde 204 igual', async () => {
    state.executeRaw.mockRejectedValue(new Error('db down'));
    const res = await post('{"k":"landing","s":"direct"}');
    expect(res.status).toBe(204);
  });

  it('OPTIONS responde 204 con CORS para cualquier origen', async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('reglas del contrato de eventos', () => {
  it('el token es wev_ + 32 caracteres url-safe', () => {
    const token = generateEventsToken();
    expect(token).toMatch(/^wev_[A-Za-z0-9_-]{32}$/);
    expect(isEventsTokenShape(token)).toBe(true);
    expect(isEventsTokenShape('wev_corto')).toBe(false);
  });

  it('un landing sin origen válido cuenta como other', () => {
    expect(parseWebEvent('{"k":"landing"}')).toEqual({ kind: 'landing', source: 'other' });
    expect(parseWebEvent('{"k":"landing","s":"tiktok"}')).toEqual({ kind: 'landing', source: 'other' });
    expect(parseWebEvent('[]')).toBeNull();
    expect(parseWebEvent('null')).toBeNull();
  });

  it('el origen admite www y subdominios, no hosts que solo terminan igual', () => {
    expect(originMatchesSite('https://clinica.example', 'https://www.clinica.example/')).toBe(true);
    expect(originMatchesSite('https://www.clinica.example', 'https://clinica.example')).toBe(true);
    expect(originMatchesSite('https://en.clinica.example', 'https://clinica.example')).toBe(true);
    expect(originMatchesSite('https://otraclinica.example', 'https://clinica.example')).toBe(false);
    expect(originMatchesSite('https://clinica.example.evil.test', 'https://clinica.example')).toBe(false);
    expect(originMatchesSite(null, 'https://clinica.example')).toBe(false);
    expect(originMatchesSite('null', 'https://clinica.example')).toBe(false);
  });
});
