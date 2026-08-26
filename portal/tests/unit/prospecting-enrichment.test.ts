// =============================================================================
// Prospección con IA, Fase B — unit tests for src/lib/prospecting-enrichment.ts.
// crawlWebsite is tested against a mocked global fetch; sweepPendingEnrichment
// against mocked Prisma + a mocked deliverChannelEvent (channel-webhook.ts's
// OWN delivery/retry logic is already covered by channel-webhook.test.ts).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  deliverChannelEvent: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/channel-webhook', () => ({
  deliverChannelEvent: (...a: unknown[]) => mockState.deliverChannelEvent(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import { crawlWebsite, sweepPendingEnrichment, ENRICHMENT_BATCH_SIZE } from '@/lib/prospecting-enrichment';

const originalFetch = global.fetch;

beforeEach(() => {
  mockState.deliverChannelEvent.mockReset().mockResolvedValue({ ok: true, deliveryId: 'd1', status: 'delivered' });
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

  it('crawls, delivers to n8n under connectionType prospecting, and stamps enrichmentRequestedAt', async () => {
    state.leadFindMany.mockResolvedValue([candidate()]);
    mockFetchOnce(() =>
      Promise.resolve(new Response('<p>Hola</p>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );

    const result = await sweepPendingEnrichment(prisma, NOW);

    expect(mockState.deliverChannelEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionType: 'prospecting',
        connectionId: 'lead_1',
        clientId: 'client_1',
        payload: { leadId: 'lead_1', rawText: 'Hola' },
      }),
    );
    expect(state.leadUpdate).toHaveBeenCalledWith({ where: { id: 'lead_1' }, data: { enrichmentRequestedAt: NOW } });
    expect(result).toEqual({ processed: 1, delivered: 1, crawlFailed: 0 });
  });

  it('a crawl failure still stamps enrichmentRequestedAt (single attempt, not retried) and never calls deliverChannelEvent', async () => {
    state.leadFindMany.mockResolvedValue([candidate()]);
    mockFetchOnce(() => Promise.resolve(new Response('gone', { status: 404 })));

    const result = await sweepPendingEnrichment(prisma, NOW);

    expect(mockState.deliverChannelEvent).not.toHaveBeenCalled();
    expect(state.leadUpdate).toHaveBeenCalledWith({ where: { id: 'lead_1' }, data: { enrichmentRequestedAt: NOW } });
    expect(mockState.logError).toHaveBeenCalledWith('prospecting_enrichment.crawl_failed', expect.anything(), { leadId: 'lead_1' }, 'warn');
    expect(result).toEqual({ processed: 1, delivered: 0, crawlFailed: 1 });
  });

  it('a delivery failure to n8n still stamps enrichmentRequestedAt — sync-channel-webhooks retries it, not this sweep', async () => {
    state.leadFindMany.mockResolvedValue([candidate()]);
    mockFetchOnce(() => Promise.resolve(new Response('<p>Hola</p>', { status: 200, headers: { 'content-type': 'text/html' } })));
    mockState.deliverChannelEvent.mockResolvedValue({ ok: false, deliveryId: 'd1', status: 'failed', error: 'n8n down' });

    const result = await sweepPendingEnrichment(prisma, NOW);

    expect(state.leadUpdate).toHaveBeenCalledWith({ where: { id: 'lead_1' }, data: { enrichmentRequestedAt: NOW } });
    expect(result).toEqual({ processed: 1, delivered: 0, crawlFailed: 0 });
  });

  it('processes multiple candidates independently', async () => {
    state.leadFindMany.mockResolvedValue([candidate({ id: 'lead_1' }), candidate({ id: 'lead_2' })]);
    mockFetchOnce(() => Promise.resolve(new Response('<p>x</p>', { status: 200, headers: { 'content-type': 'text/html' } })));

    const result = await sweepPendingEnrichment(prisma, NOW);

    expect(mockState.deliverChannelEvent).toHaveBeenCalledTimes(2);
    expect(result.processed).toBe(2);
  });
});
