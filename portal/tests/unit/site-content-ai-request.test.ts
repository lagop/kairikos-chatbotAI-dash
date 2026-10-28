// La petición a la API de la ampliación del borrador (site-content-ai.ts).
//
// 28/10/2026 — medido en producción: Haiku 5.5 razona por su cuenta si no se
// le dice, se gastaba 5.200–5.700 tokens pensando y, con la portada más
// currada, 2 de cada 5 respuestas se cortaban en el tope sin JSON. Sonnet 5.5
// rechaza `thinking: disabled` con un 400. Esto fija las dos cosas.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/anthropic-credentials', () => ({
  resolveActiveAnthropicCredentials: vi.fn(async () => ({ apiKey: 'k', baseUrl: 'https://api.example', model: 'm' })),
}));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { expandDraftToSiteContent } from '@/lib/site-content-ai';

const input = {
  businessName: 'Aluminios Telde',
  kind: null,
  city: 'Telde',
  copy: { headline: 'Ventanas a medida', subheadline: '', about: '', services: [{ name: 'Ventanas', description: 'A medida' }], callToAction: '' },
  iconIds: [],
};

describe('expandDraftToSiteContent: la petición', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: 'text', text: '{"cifras":[]}' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_SITE_CONTENT_MODEL;
  });
  const body = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  it('con Haiku (el de siempre), sin razonamiento', async () => {
    expect((await expandDraftToSiteContent(input)).ok).toBe(true);
    expect(body()).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, max_tokens: 8000 });
  });

  it('con otro modelo, sin `disabled` (Sonnet 5.5 lo rechaza) y con más tope', async () => {
    process.env.ANTHROPIC_SITE_CONTENT_MODEL = 'claude-sonnet-5-5';
    await expandDraftToSiteContent(input);
    expect(body().thinking).toBeUndefined();
    expect(body().max_tokens).toBe(16000);
  });
});
