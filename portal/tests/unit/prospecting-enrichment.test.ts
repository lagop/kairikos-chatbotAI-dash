// =============================================================================
// Prospección con IA, Fase B — unit tests for src/lib/prospecting-enrichment.ts.
// crawlWebsite is tested against a mocked global fetch; sweepPendingEnrichment
// against mocked Prisma + a mocked deliverChannelEvent (channel-webhook.ts's
// OWN delivery/retry logic is already covered by channel-webhook.test.ts).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// safeFetch conecta con http/https de Node, no con fetch: aquí se enruta al
// fetch simulado de este archivo. Sus propias garantías (qué IPs, qué
// redirecciones) se prueban en safe-fetch.test.ts.
vi.mock('@/lib/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safe-fetch')>()),
  safeFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}));

import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  applyLeadEnrichment: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/leads', () => ({
  applyLeadEnrichment: (...a: unknown[]) => mockState.applyLeadEnrichment(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import {
  crawlWebsite,
  sweepPendingEnrichment,
  extractContactFromText,
  extractEmail,
  extractPhone,
  ENRICHMENT_BATCH_SIZE,
} from '@/lib/prospecting-enrichment';

const originalFetch = global.fetch;

beforeEach(() => {
  mockState.applyLeadEnrichment.mockReset().mockResolvedValue({ leadId: 'lead_1', changed: true });
  mockState.logError.mockReset();
});

afterEach(() => {
  global.fetch = originalFetch;
});

function mockFetchOnce(impl: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  global.fetch = vi.fn(impl) as unknown as typeof fetch;
}

describe('crawlWebsite', () => {
  it('strips scripts, styles, and tags down to plain text', async () => {
    mockFetchOnce(() =>
      Promise.resolve(
        new Response(
          '<html><head><style>.x{color:red}</style><script>track()</script></head><body><h1>Ferretería Central</h1><p>Contacto: info@ferreteria.example &amp; +34 922 000 000</p></body></html>',
          { status: 200, headers: { 'content-type': 'text/html' } },
        ),
      ),
    );
    const result = await crawlWebsite('https://ferreteria.example');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rawText).toContain('Ferretería Central');
      expect(result.data.rawText).toContain('info@ferreteria.example & +34 922 000 000');
      expect(result.data.rawText).not.toContain('track()');
      expect(result.data.rawText).not.toContain('color:red');
      expect(result.data.rawText).not.toContain('<');
    }
  });

  it('truncates very long pages so the n8n payload stays bounded', async () => {
    mockFetchOnce(() =>
      Promise.resolve(new Response(`<p>${'a'.repeat(50_000)}</p>`, { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    const result = await crawlWebsite('https://big.example');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.rawText.length).toBeLessThanOrEqual(20_000);
    }
  });

  it('fails on a non-2xx response', async () => {
    mockFetchOnce(() => Promise.resolve(new Response('not found', { status: 404 })));
    const result = await crawlWebsite('https://gone.example');
    expect(result).toEqual({ ok: false, error: 'http_404' });
  });

  it('fails on an unsupported content type instead of trying to text-strip a binary', async () => {
    mockFetchOnce(() =>
      Promise.resolve(new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } })),
    );
    const result = await crawlWebsite('https://brochure.example');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('unsupported_content_type');
  });

  it('reports a network failure without throwing', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as unknown as typeof fetch;
    const result = await crawlWebsite('https://doesnotexist.example');
    expect(result).toEqual({ ok: false, error: 'ENOTFOUND' });
  });

  it('reports a timeout distinctly from other failures', async () => {
    global.fetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;
    // Fire the abort synchronously instead of waiting the real 8s timeout.
    const promise = crawlWebsite('https://slow.example');
    const controllerAbort = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit | undefined;
    controllerAbort?.signal?.dispatchEvent(new Event('abort'));
    const result = await promise;
    expect(result).toEqual({ ok: false, error: 'timeout' });
  });
});

// =============================================================================
// Fase 1.4 — la extracción es determinista a propósito: en un producto que
// luego contacta solo por WhatsApp, un teléfono alucinado sería un mensaje
// a un desconocido. Lo que protegen estos tests es justo eso.
// =============================================================================

describe('extractEmail', () => {
  it('encuentra el email de contacto', () => {
    expect(extractEmail('Escríbenos a hola@peluqueria.example y te contamos')).toBe('hola@peluqueria.example');
  });

  it('prefiere el buzón genérico del negocio antes que el personal de alguien', () => {
    expect(extractEmail('marta.lopez@negocio.example · info@negocio.example')).toBe('info@negocio.example');
  });

  it('descarta buzones que no son un contacto real', () => {
    expect(extractEmail('noreply@negocio.example')).toBeNull();
    expect(extractEmail('postmaster@negocio.example')).toBeNull();
  });

  it('descarta dominios de ejemplo y ficheros que parecen emails', () => {
    expect(extractEmail('correo@example.com')).toBeNull();
    expect(extractEmail('tu@tudominio.com')).toBeNull();
    expect(extractEmail('logo@2x.png')).toBeNull();
  });

  it('normaliza a minúsculas', () => {
    expect(extractEmail('INFO@Negocio.Example')).toBe('info@negocio.example');
  });

  it('devuelve null cuando no hay ninguno', () => {
    expect(extractEmail('Bienvenidos a nuestra web')).toBeNull();
  });
});

describe('extractPhone', () => {
  it('encuentra móviles y fijos españoles con los separadores habituales', () => {
    expect(extractPhone('Llámanos al 622 33 44 55')).toBe('+34622334455');
    expect(extractPhone('Tel. 928-45-67-89')).toBe('+34928456789');
    expect(extractPhone('Teléfono: 911.22.33.44')).toBe('+34911223344');
  });

  it('acepta el prefijo internacional y lo normaliza igual', () => {
    expect(extractPhone('+34 622 334 455')).toBe('+34622334455');
    expect(extractPhone('0034622334455')).toBe('+34622334455');
  });

  it('no confunde con un teléfono una cifra más larga', () => {
    // Un IBAN, un número de pedido o un NIF pegado a más dígitos.
    expect(extractPhone('ES6621000418401234567891')).toBeNull();
    expect(extractPhone('pedido 9112233445566')).toBeNull();
  });

  it('descarta números que no empiezan por 6, 7, 8 o 9', () => {
    expect(extractPhone('código 123456789')).toBeNull();
  });

  it('devuelve null cuando no hay ninguno', () => {
    expect(extractPhone('Abierto de lunes a viernes')).toBeNull();
  });
});

describe('extractContactFromText', () => {
  it('nunca devuelve algo que no esté literalmente en el texto', () => {
    const texto = 'Peluquería Aurora · Calle Mayor 4 · info@aurora.example · 622 33 44 55';
    const { contactEmail, contactPhone } = extractContactFromText(texto);
    expect(texto).toContain(contactEmail!);
    expect(texto.replace(/\s/g, '')).toContain(contactPhone!.replace('+34', ''));
  });

  it('devuelve null en los campos que no aparecen, sin inventarlos', () => {
    expect(extractContactFromText('Solo tenemos email: hola@x.example')).toEqual({
      contactEmail: 'hola@x.example',
      contactPhone: null,
    });
    expect(extractContactFromText('Solo teléfono: 622334455')).toEqual({
      contactEmail: null,
      contactPhone: '+34622334455',
    });
  });
});

const state = {
  leadFindMany: vi.fn(),
  leadUpdate: vi.fn(),
};

const prisma = {
  lead: {
    findMany: (...a: unknown[]) => state.leadFindMany(...a),
    update: (...a: unknown[]) => state.leadUpdate(...a),
  },
} as unknown as PrismaClient;

const NOW = new Date('2026-09-06T10:00:00.000Z');

function candidate(over: Record<string, unknown> = {}) {
  return { id: 'lead_1', clientId: 'client_1', website: 'https://negocio.example', ...over };
}

describe('sweepPendingEnrichment', () => {
  beforeEach(() => {
    state.leadFindMany.mockReset().mockResolvedValue([]);
    state.leadUpdate.mockReset().mockResolvedValue({});
  });

  it('only selects outbound leads with a website that have never been attempted', async () => {
    await sweepPendingEnrichment(prisma, NOW);
    expect(state.leadFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { source: 'outbound', website: { not: null }, enrichmentRequestedAt: null },
        take: ENRICHMENT_BATCH_SIZE,
      }),
    );
  });

  it('extrae los contactos de la web y los guarda, marcando el intento', async () => {
    state.leadFindMany.mockResolvedValue([candidate()]);
    mockFetchOnce(() =>
      Promise.resolve(new Response('<p>Escríbenos a info@negocio.example o llama al 622 33 44 55</p>', {
        status: 200, headers: { 'content-type': 'text/html' },
      })),
    );

    const result = await sweepPendingEnrichment(prisma, NOW);

    expect(mockState.applyLeadEnrichment).toHaveBeenCalledWith(
      prisma,
      'lead_1',
      { contactEmail: 'info@negocio.example', contactPhone: '+34622334455' },
      'system:prospecting',
    );
    expect(state.leadUpdate).toHaveBeenCalledWith({ where: { id: 'lead_1' }, data: { enrichmentRequestedAt: NOW } });
    expect(result).toEqual({ processed: 1, enriched: 1, crawlFailed: 0, noContactFound: 0 });
  });

  it('una web sin contactos se marca igual: volver mañana no cambiaría el texto', async () => {
    state.leadFindMany.mockResolvedValue([candidate()]);
    mockFetchOnce(() =>
      Promise.resolve(new Response('<p>Bienvenidos a nuestra web</p>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );

    const result = await sweepPendingEnrichment(prisma, NOW);

    expect(mockState.applyLeadEnrichment).not.toHaveBeenCalled();
    expect(state.leadUpdate).toHaveBeenCalledWith({ where: { id: 'lead_1' }, data: { enrichmentRequestedAt: NOW } });
    expect(result).toEqual({ processed: 1, enriched: 0, crawlFailed: 0, noContactFound: 1 });
  });

  it('un rastreo fallido se marca y no escribe nada (un intento, sin reintentos)', async () => {
    state.leadFindMany.mockResolvedValue([candidate()]);
    mockFetchOnce(() => Promise.resolve(new Response('gone', { status: 404 })));

    const result = await sweepPendingEnrichment(prisma, NOW);

    expect(mockState.applyLeadEnrichment).not.toHaveBeenCalled();
    expect(state.leadUpdate).toHaveBeenCalledWith({ where: { id: 'lead_1' }, data: { enrichmentRequestedAt: NOW } });
    expect(mockState.logError).toHaveBeenCalledWith('prospecting_enrichment.crawl_failed', expect.anything(), { leadId: 'lead_1' }, 'warn');
    expect(result).toEqual({ processed: 1, enriched: 0, crawlFailed: 1, noContactFound: 0 });
  });

  it('procesa varios candidatos de forma independiente', async () => {
    state.leadFindMany.mockResolvedValue([candidate({ id: 'lead_1' }), candidate({ id: 'lead_2' })]);
    mockFetchOnce(() =>
      Promise.resolve(new Response('<p>info@x.example</p>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );

    const result = await sweepPendingEnrichment(prisma, NOW);

    expect(mockState.applyLeadEnrichment).toHaveBeenCalledTimes(2);
    expect(result.processed).toBe(2);
  });
});
