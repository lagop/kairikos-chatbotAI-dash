// =============================================================================
// POST /api/portal/prospecting/campaign/suggest — propone a quién buscar.
// No guarda nada: el cliente confirma con el PATCH de siempre.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  getSession: vi.fn(),
  resolveClientFromSession: vi.fn(),
  isProductContracted: vi.fn(),
  clientFindUnique: vi.fn(),
  crawlWebsite: vi.fn(),
  suggestProspectingTargets: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: { chatbotClient: { findUnique: (...a: unknown[]) => mockState.clientFindUnique(...a) } },
}));
vi.mock('@/lib/session', () => ({ getSession: (...a: unknown[]) => mockState.getSession(...a) }));
vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...a: unknown[]) => mockState.resolveClientFromSession(...a),
}));
vi.mock('@/lib/client-product-access', () => ({
  isProductContracted: (...a: unknown[]) => mockState.isProductContracted(...a),
}));
vi.mock('@/lib/prospecting-enrichment', () => ({ crawlWebsite: (...a: unknown[]) => mockState.crawlWebsite(...a) }));
vi.mock('@/lib/prospecting-brief-ai', () => ({
  suggestProspectingTargets: (...a: unknown[]) => mockState.suggestProspectingTargets(...a),
  MAX_WEBSITE_CHARS: 3000,
}));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import { POST } from '@/app/api/portal/prospecting/campaign/suggest/route';

const SUGGESTION = { categories: ['administradores de fincas'], locations: [], exclusions: [], businessSummary: null };
const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.getSession.mockResolvedValue({ hasClientAccess: true });
  mockState.resolveClientFromSession.mockResolvedValue({ clientId: 'client_1', source: 'database' });
  mockState.isProductContracted.mockResolvedValue(true);
  mockState.clientFindUnique.mockResolvedValue({ name: 'Orly', companyName: 'Reformas Orly' });
  mockState.crawlWebsite.mockResolvedValue({ ok: true, data: { rawText: 'Reformamos baños' } });
  mockState.suggestProspectingTargets.mockResolvedValue({ ok: true, suggestion: SUGGESTION });
});

describe('POST suggest', () => {
  it('401 sin sesión y 403 sin el producto contratado', async () => {
    mockState.getSession.mockResolvedValueOnce({ hasClientAccess: false });
    expect((await POST(req({}))).status).toBe(401);
    mockState.isProductContracted.mockResolvedValueOnce(false);
    expect((await POST(req({}))).status).toBe(403);
    expect(mockState.suggestProspectingTargets).not.toHaveBeenCalled();
  });

  it('rastrea la web, propone y NO guarda nada', async () => {
    const res = await POST(req({ clientWebsite: 'reformasorly.com', businessDescription: 'reformas' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestion: SUGGESTION, websiteRead: true, websiteError: null });
    // Sin protocolo, se asume https.
    expect(mockState.crawlWebsite).toHaveBeenCalledWith('https://reformasorly.com/');
    expect(mockState.suggestProspectingTargets).toHaveBeenCalledWith(
      expect.objectContaining({ businessName: 'Reformas Orly', websiteText: 'Reformamos baños' }),
    );
  });

  it.each([
    ['http://localhost/panel'],
    ['http://127.0.0.1'],
    ['http://192.168.1.10'],
    ['http://169.254.169.254/latest/meta-data'],
    ['ftp://archivos.example'],
  ])('no sale a internet contra %s', async (url) => {
    const res = await POST(req({ clientWebsite: url, businessDescription: 'reformas' }));
    expect(mockState.crawlWebsite).not.toHaveBeenCalled();
    expect((await res.json()).websiteError).toBe('invalid_url');
  });

  it('si la web no carga, propone igual con lo que escribió el cliente', async () => {
    mockState.crawlWebsite.mockResolvedValue({ ok: false, error: 'timeout' });
    const res = await POST(req({ clientWebsite: 'reformasorly.com', businessDescription: 'reformas' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.websiteError).toBe('crawl_failed');
    expect(body.suggestion).toEqual(SUGGESTION);
  });

  it('traslada el motivo cuando la IA se salta la propuesta', async () => {
    mockState.suggestProspectingTargets.mockResolvedValue({ ok: true, skipped: true, reason: 'no_api_key' });
    const res = await POST(req({ businessDescription: 'reformas' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ skipped: 'no_api_key' });
  });

  it('502 y log cuando la IA falla', async () => {
    mockState.suggestProspectingTargets.mockResolvedValue({ ok: false, error: 'anthropic_api_error:500:' });
    const res = await POST(req({ businessDescription: 'reformas' }));
    expect(res.status).toBe(502);
    expect(mockState.logError).toHaveBeenCalled();
  });
});
