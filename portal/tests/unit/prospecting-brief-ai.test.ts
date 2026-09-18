// =============================================================================
// Fase A — proponer a quién buscar. Ver lib/prospecting-brief-ai.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  resolveActiveAnthropicCredentials: vi.fn(),
  fetch: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/anthropic-credentials', () => ({
  resolveActiveAnthropicCredentials: (...a: unknown[]) => mockState.resolveActiveAnthropicCredentials(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));

import {
  parseProspectingSuggestion,
  hasEnoughContext,
  suggestProspectingTargets,
  isProspectingSuggestionConfigured,
} from '@/lib/prospecting-brief-ai';

const INPUT = {
  businessName: 'Reformas Orly',
  businessDescription: 'reformas de baños y cocinas',
  idealCustomer: null,
  exclusions: null,
  websiteText: null,
  knownLocation: 'Las Palmas',
};

function anthropicReply(text: string) {
  return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) } as unknown as Response;
}

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.resolveActiveAnthropicCredentials.mockResolvedValue({
    apiKey: 'sk-ant-xxx',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-haiku-4-5-20251001',
  });
  vi.stubGlobal('fetch', mockState.fetch);
});

describe('parseProspectingSuggestion', () => {
  it('quita la valla de markdown, recorta, deduplica y limita a seis', () => {
    const many = Array.from({ length: 9 }, (_, i) => `rubro ${i}`);
    const parsed = parseProspectingSuggestion(
      '```json\n' +
        JSON.stringify({
          categories: ['Administradores de fincas', 'administradores de fincas', ...many, 7, ''],
          locations: ['Las Palmas de Gran Canaria'],
          exclusions: ['obra nueva'],
          businessSummary: 'Reforma baños y cocinas para comunidades.',
        }) +
        '\n```',
    );
    expect(parsed?.categories).toHaveLength(6);
    expect(parsed?.categories[0]).toBe('Administradores de fincas');
    // La repetición con otra caja no cuenta dos veces.
    expect(parsed?.categories.filter((c) => c.toLowerCase() === 'administradores de fincas')).toHaveLength(1);
    expect(parsed?.locations).toEqual(['Las Palmas de Gran Canaria']);
    expect(parsed?.businessSummary).toBe('Reforma baños y cocinas para comunidades.');
  });

  it('sin un solo rubro no hay propuesta: mejor decirlo que pintar un hueco', () => {
    expect(parseProspectingSuggestion(JSON.stringify({ categories: [], locations: ['x'] }))).toBeNull();
    expect(parseProspectingSuggestion('esto no es JSON')).toBeNull();
    expect(parseProspectingSuggestion('[]')).toBeNull();
  });
});

describe('hasEnoughContext', () => {
  it('basta con una de las tres cosas; solo el nombre no', () => {
    expect(hasEnoughContext({ businessName: 'X' })).toBe(false);
    expect(hasEnoughContext({ businessName: 'X', businessDescription: ' ' })).toBe(false);
    expect(hasEnoughContext({ businessName: 'X', idealCustomer: 'comunidades' })).toBe(true);
    expect(hasEnoughContext({ businessName: 'X', websiteText: 'texto de la web' })).toBe(true);
  });
});

describe('suggestProspectingTargets', () => {
  it('degrada con gracia sin clave y sin contexto, sin llamar a la red', async () => {
    await expect(suggestProspectingTargets({ businessName: 'X' })).resolves.toEqual({
      ok: true,
      skipped: true,
      reason: 'not_enough_context',
    });
    mockState.resolveActiveAnthropicCredentials.mockResolvedValue(null);
    await expect(suggestProspectingTargets(INPUT)).resolves.toEqual({ ok: true, skipped: true, reason: 'no_api_key' });
    await expect(isProspectingSuggestionConfigured()).resolves.toBe(false);
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('pide JSON estricto y devuelve la propuesta', async () => {
    mockState.fetch.mockResolvedValue(
      anthropicReply(JSON.stringify({ categories: ['administradores de fincas'], locations: [], exclusions: [] })),
    );
    const result = await suggestProspectingTargets(INPUT);
    expect(result).toEqual({
      ok: true,
      suggestion: { categories: ['administradores de fincas'], locations: [], exclusions: [], businessSummary: null },
    });
    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body as string);
    expect(body.system).toContain('SOLO con un objeto JSON');
    expect(body.messages[0].content).toContain('reformas de baños y cocinas');
    expect(body.messages[0].content).toContain('Las Palmas');
  });

  it('recorta el texto de la web para acotar el gasto por llamada', async () => {
    mockState.fetch.mockResolvedValue(anthropicReply(JSON.stringify({ categories: ['x'] })));
    await suggestProspectingTargets({ ...INPUT, websiteText: 'a'.repeat(9000) });
    const content = JSON.parse(mockState.fetch.mock.calls[0][1].body as string).messages[0].content as string;
    expect(content.length).toBeLessThan(4000);
  });

  it('nunca lanza: un error de la API o de red vuelve como resultado', async () => {
    mockState.fetch.mockResolvedValue({ ok: false, status: 429, text: async () => 'slow down' } as unknown as Response);
    await expect(suggestProspectingTargets(INPUT)).resolves.toMatchObject({ ok: false });

    mockState.fetch.mockResolvedValue(anthropicReply('no es json'));
    await expect(suggestProspectingTargets(INPUT)).resolves.toEqual({ ok: false, error: 'anthropic_api_invalid_json' });

    mockState.fetch.mockRejectedValue(new Error('socket hang up'));
    await expect(suggestProspectingTargets(INPUT)).resolves.toEqual({ ok: false, error: 'socket hang up' });
    expect(mockState.logError).toHaveBeenCalled();
  });
});
