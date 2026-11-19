// =============================================================================
// Cartera — «Traducir con IA» (lib/cartera-translation-ai.ts), con el cliente
// de Anthropic simulado: propone inglés y alemán, nunca lanza, sin clave se
// salta, y el parseo descarta lo que no se pidió.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  resolveActiveAnthropicCredentials: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/anthropic-credentials', () => ({
  resolveActiveAnthropicCredentials: (...a: unknown[]) => mockState.resolveActiveAnthropicCredentials(...a),
}));

import { isEmptyTranslationInput, parseTranslationResponse, translateHomeTexts, type TranslationInput } from '@/lib/cartera-translation-ai';

const INPUT: TranslationInput = {
  title: 'Villa con vistas al mar',
  summary: 'Cuatro dormitorios y jardín.',
  floor: '',
  lacks: ['Sin garaje', ''],
  alts: [
    { id: 'p1', text: 'Fachada' },
    { id: 'p2', text: '' },
  ],
};

const GOOD = {
  title: { en: 'Villa with sea views', de: 'Villa mit Meerblick' },
  summary: { en: 'Four bedrooms and a garden.', de: 'Vier Schlafzimmer und Garten.' },
  floor: { en: 'Ground floor', de: 'Erdgeschoss' },
  lacks: [{ en: 'No garage', de: 'Keine Garage' }, { en: 'extra', de: 'extra' }],
  alts: [
    { id: 'p1', en: 'Front', de: 'Fassade' },
    { id: 'p2', en: 'x', de: 'y' },
    { id: 'p9', en: 'x', de: 'y' },
  ],
};

function anthropicReply(text: string) {
  return { ok: true, json: async () => ({ content: [{ type: 'text', text }] }) } as unknown as Response;
}

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.resolveActiveAnthropicCredentials.mockResolvedValue({ apiKey: 'sk-ant-test', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001' });
  vi.stubGlobal('fetch', mockState.fetch);
  delete process.env.ANTHROPIC_CARTERA_TRANSLATION_MODEL;
});

describe('parseTranslationResponse', () => {
  it('quita la valla de markdown y devuelve solo lo que se pidió', () => {
    const p = parseTranslationResponse('```json\n' + JSON.stringify(GOOD) + '\n```', INPUT);
    expect(p).toEqual({
      title: GOOD.title,
      summary: GOOD.summary,
      // La planta venía vacía en español: no se acepta una inventada.
      floor: null,
      lacks: [{ en: 'No garage', de: 'Keine Garage' }, null],
      alts: [{ id: 'p1', en: 'Front', de: 'Fassade' }],
    });
  });

  it('JSON roto o con otra forma: null, no una excepción', () => {
    expect(parseTranslationResponse('no es json', INPUT)).toBeNull();
    expect(parseTranslationResponse('[1,2]', INPUT)).toBeNull();
    expect(parseTranslationResponse('{"title":"solo texto"}', INPUT)).toMatchObject({ title: null, lacks: [null, null], alts: [] });
  });

  it('una traducción sin uno de los dos idiomas no vale', () => {
    expect(parseTranslationResponse(JSON.stringify({ ...GOOD, title: { en: 'Villa', de: '' } }), INPUT)?.title).toBeNull();
  });

  it('nada en español: nada que traducir', () => {
    expect(isEmptyTranslationInput({ title: ' ', summary: '', floor: '', lacks: [''], alts: [{ id: 'a', text: '' }] })).toBe(true);
    expect(isEmptyTranslationInput(INPUT)).toBe(false);
  });
});

describe('translateHomeTexts', () => {
  it('sin clave configurada se salta, sin llamar a nadie', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValue(null);
    expect(await translateHomeTexts(INPUT)).toEqual({ ok: true, skipped: true, reason: 'no_api_key' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('llama a la Messages API con Haiku sin razonamiento y manda solo los textos con contenido', async () => {
    mockState.fetch.mockResolvedValue(anthropicReply(JSON.stringify(GOOD)));
    const r = await translateHomeTexts(INPUT);
    expect(r).toMatchObject({ ok: true, model: 'claude-haiku-4-5-20251001', proposal: { title: GOOD.title } });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    const body = JSON.parse(init.body);
    expect(body.thinking).toEqual({ type: 'disabled' });
    const sent = JSON.parse(body.messages[0].content);
    expect(sent).toEqual({ title: INPUT.title, summary: INPUT.summary, floor: null, lacks: ['Sin garaje', null], alts: [{ id: 'p1', es: 'Fachada' }] });
  });

  it('otro modelo por variable de entorno (solo local), sin el parámetro de Haiku', async () => {
    process.env.ANTHROPIC_CARTERA_TRANSLATION_MODEL = 'claude-sonnet-5-5';
    mockState.fetch.mockResolvedValue(anthropicReply(JSON.stringify(GOOD)));
    await translateHomeTexts(INPUT);
    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.thinking).toBeUndefined();
  });

  it('nunca lanza: error de la API, respuesta vacía, JSON roto o red caída', async () => {
    mockState.fetch.mockResolvedValueOnce({ ok: false, status: 529, text: async () => 'overloaded' } as unknown as Response);
    expect(await translateHomeTexts(INPUT)).toMatchObject({ ok: false, error: expect.stringContaining('anthropic_api_error:529') });
    mockState.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ content: [] }) } as unknown as Response);
    expect(await translateHomeTexts(INPUT)).toEqual({ ok: false, error: 'anthropic_api_empty_response' });
    mockState.fetch.mockResolvedValueOnce(anthropicReply('Lo siento, no puedo.'));
    expect(await translateHomeTexts(INPUT)).toEqual({ ok: false, error: 'anthropic_api_invalid_json' });
    mockState.fetch.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect(await translateHomeTexts(INPUT)).toEqual({ ok: false, error: 'ECONNRESET' });
  });
});
