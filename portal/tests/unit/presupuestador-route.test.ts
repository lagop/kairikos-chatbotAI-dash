import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/prisma', () => ({ prisma: {}, isDatabaseConfigured: true }));
vi.mock('@/lib/premium-quoter', () => ({
  loadResolvedQuoter: vi.fn(),
  createPremiumQuoteRequest: vi.fn(),
  notifyPremiumQuote: vi.fn(),
}));

import { GET, OPTIONS, POST } from '@/app/api/public/presupuestador/route';
import { createPremiumQuoteRequest, loadResolvedQuoter } from '@/lib/premium-quoter';

// 10/11/2026 — el presupuestador ya no va en un marco del portal: un script lo
// pinta dentro de kairikos.com, así que sus peticiones llegan de otro origen.

const URL_API = 'https://portal.kairikos.cloud/api/public/presupuestador';
const req = (method: string, origin: string | null, body?: unknown) =>
  new NextRequest(URL_API, {
    method,
    headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const quoter = (published: boolean) => ({ ok: true, quoter: { config: { published } } });

beforeEach(() => vi.clearAllMocks());

describe('CORS', () => {
  it('kairikos.com puede hacer la petición previa', async () => {
    const res = await OPTIONS(req('OPTIONS', 'https://kairikos.com'));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://kairikos.com');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
  });

  it('también con www', async () => {
    const res = await OPTIONS(req('OPTIONS', 'https://www.kairikos.com'));
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.kairikos.com');
  });

  it('otra web no recibe permiso', async () => {
    const res = await OPTIONS(req('OPTIONS', 'https://kairikos.com.evil.example'));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('localhost solo fuera de producción', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await OPTIONS(req('OPTIONS', 'http://localhost:4183'));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe('GET', () => {
  it('sin publicar es 404, para que el script no pinte nada', async () => {
    vi.mocked(loadResolvedQuoter).mockResolvedValue(quoter(false) as never);
    const res = await GET(req('GET', 'https://kairikos.com'));
    expect(res.status).toBe(404);
  });

  it('publicado devuelve los datos, sin caché y con permiso para kairikos.com', async () => {
    vi.mocked(loadResolvedQuoter).mockResolvedValue(quoter(true) as never);
    const res = await GET(req('GET', 'https://kairikos.com'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quoter: { config: { published: true } } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://kairikos.com');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('si falta un precio del catálogo, tampoco se sirve', async () => {
    vi.mocked(loadResolvedQuoter).mockResolvedValue({ ok: false, missing: ['reviews/basic'] } as never);
    expect((await GET(req('GET', 'https://kairikos.com'))).status).toBe(404);
  });
});

describe('POST', () => {
  const body = { nombre: 'Ana', empresa: 'Clínica X', email: 'a@x.es', franja: 'Tarde (16–19 h)', sector: 'dental', respuestas: {}, consent: true };

  it('la respuesta lleva el permiso, o el navegador no deja leerla', async () => {
    vi.mocked(createPremiumQuoteRequest).mockResolvedValue({ ok: true, saved: null });
    const res = await POST(req('POST', 'https://kairikos.com', body));
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://kairikos.com');
  });

  it('sin la casilla de privacidad no llega al lib', async () => {
    const res = await POST(req('POST', 'https://kairikos.com', { ...body, consent: false }));
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://kairikos.com');
    expect(createPremiumQuoteRequest).not.toHaveBeenCalled();
  });
});
