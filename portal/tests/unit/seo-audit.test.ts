// =============================================================================
// SEO con IA, Fase A — unit tests for src/lib/seo-audit.ts. Mocked-fetch
// coverage of the HTML extraction (title, meta description, headings,
// image alt text, link classification) and the bounded broken-link
// check — same convention as google-places.test.ts/prospecting-
// enrichment.test.ts (never a live network call in a unit test).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditWebsite } from '@/lib/seo-audit';

const mockState = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.stubGlobal('fetch', mockState.fetch);

function htmlResponse(body: string, ok = true, status = 200, contentType = 'text/html') {
  return {
    ok,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  } as unknown as Response;
}

function headResponse(status: number) {
  return { status } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
});

describe('auditWebsite — page fetch', () => {
  it('fails on a non-2xx response', async () => {
    mockState.fetch.mockResolvedValueOnce(htmlResponse('not found', false, 404));
    const result = await auditWebsite('https://gone.example');
    expect(result).toEqual({ ok: false, error: 'http_404' });
  });

  it('fails on an unsupported content type', async () => {
    mockState.fetch.mockResolvedValueOnce(htmlResponse('%PDF', true, 200, 'application/pdf'));
    const result = await auditWebsite('https://brochure.example');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unsupported_content_type');
  });

  it('reports a network failure without throwing', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const result = await auditWebsite('https://doesnotexist.example');
    expect(result).toEqual({ ok: false, error: 'ENOTFOUND' });
  });
});

describe('auditWebsite — extraction', () => {
  it('extracts title, meta description, and a single correct H1', async () => {
    mockState.fetch.mockResolvedValueOnce(
      htmlResponse(`
        <html><head>
          <title>Ferretería Central — Las Palmas</title>
          <meta name="description" content="Herramientas y menaje en el centro de Las Palmas">
        </head><body>
          <h1>Bienvenido a Ferretería Central</h1>
        </body></html>
      `),
    );
    const result = await auditWebsite('https://ferreteria.example');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.title).toBe('Ferretería Central — Las Palmas');
      expect(result.data.metaDescription).toBe('Herramientas y menaje en el centro de Las Palmas');
      expect(result.data.h1Count).toBe(1);
      expect(result.data.h1Texts).toEqual(['Bienvenido a Ferretería Central']);
    }
  });

  it('null title/meta description when absent, rather than throwing', async () => {
    mockState.fetch.mockResolvedValueOnce(htmlResponse('<html><body><p>Sin nada arriba</p></body></html>'));
    const result = await auditWebsite('https://minimal.example');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.title).toBeNull();
      expect(result.data.metaDescription).toBeNull();
      expect(result.data.h1Count).toBe(0);
    }
  });

  it('flags more than one H1 (an SEO smell) via h1Count, not an error', async () => {
    mockState.fetch.mockResolvedValueOnce(
      htmlResponse('<html><body><h1>Uno</h1><h1>Dos</h1></body></html>'),
    );
    const result = await auditWebsite('https://twoheadings.example');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.h1Count).toBe(2);
  });

  it('counts images and how many are missing alt text (empty alt counts as missing)', async () => {
    mockState.fetch.mockResolvedValueOnce(
      htmlResponse(`
        <html><body>
          <img src="a.jpg" alt="Fachada de la tienda">
          <img src="b.jpg" alt="">
          <img src="c.jpg">
        </body></html>
      `),
    );
    const result = await auditWebsite('https://images.example');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.imagesTotal).toBe(3);
      expect(result.data.imagesMissingAlt).toBe(2);
    }
  });

  it('classifies links as internal (same origin) or external, skipping mailto/tel/anchor', async () => {
    mockState.fetch.mockResolvedValueOnce(
      htmlResponse(`
        <html><body>
          <a href="/contacto">Contacto</a>
          <a href="https://negocio.example/sobre-nosotros">Sobre nosotros</a>
          <a href="https://otrositio.example">Enlace externo</a>
          <a href="mailto:info@negocio.example">Email</a>
          <a href="tel:+34922000000">Teléfono</a>
          <a href="#top">Ancla</a>
        </body></html>
      `),
    );
    const result = await auditWebsite('https://negocio.example');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.linksInternal).toBe(2);
      expect(result.data.linksExternal).toBe(1);
    }
  });

  it('skips a malformed href instead of failing the whole audit', async () => {
    mockState.fetch.mockResolvedValueOnce(
      // An absolute URL with an invalid IPv6 host genuinely throws in the
      // WHATWG URL constructor (unlike most odd strings, which resolve
      // fine as a relative path against the base).
      htmlResponse('<html><body><a href="http://[::bad-ipv6">Roto</a><a href="/ok">Bien</a></body></html>'),
    );
    const result = await auditWebsite('https://negocio.example');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.linksInternal).toBe(1);
  });
});

describe('auditWebsite — broken-link check', () => {
  it('reports internal links that respond with a 4xx/5xx as broken', async () => {
    mockState.fetch
      .mockResolvedValueOnce(htmlResponse('<html><body><a href="/roto">Enlace</a></body></html>'))
      .mockResolvedValueOnce(headResponse(404));
    const result = await auditWebsite('https://negocio.example');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.brokenLinksChecked).toBe(1);
      expect(result.data.brokenLinks).toEqual([{ url: 'https://negocio.example/roto', status: 404 }]);
    }
  });

  it('a link check that throws (timeout/network) counts as broken with status null', async () => {
    mockState.fetch
      .mockResolvedValueOnce(htmlResponse('<html><body><a href="/lento">Enlace</a></body></html>'))
      .mockRejectedValueOnce(new Error('timeout'));
    const result = await auditWebsite('https://negocio.example');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.brokenLinks).toEqual([{ url: 'https://negocio.example/lento', status: null }]);
    }
  });

  it('a healthy 200 internal link is not reported as broken', async () => {
    mockState.fetch
      .mockResolvedValueOnce(htmlResponse('<html><body><a href="/ok">Enlace</a></body></html>'))
      .mockResolvedValueOnce(headResponse(200));
    const result = await auditWebsite('https://negocio.example');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.brokenLinks).toEqual([]);
  });

  it('only checks the first LINK_CHECK_CAP (10) internal links, never external ones', async () => {
    const links = Array.from({ length: 15 }, (_, i) => `<a href="/pagina-${i}">Enlace ${i}</a>`).join('');
    mockState.fetch.mockResolvedValueOnce(htmlResponse(`<html><body>${links}</body></html>`));
    for (let i = 0; i < 10; i++) mockState.fetch.mockResolvedValueOnce(headResponse(200));

    const result = await auditWebsite('https://negocio.example');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.brokenLinksChecked).toBe(10);
    // 1 page fetch + 10 link checks, never 16.
    expect(mockState.fetch).toHaveBeenCalledTimes(11);
  });
});
