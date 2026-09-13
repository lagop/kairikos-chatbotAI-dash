// =============================================================================
// Fase 1.3 — unit tests para src/lib/seo-content-ai.ts.
//
// Lo que se protege: que el prompt lleve las consultas reales de Search
// Console (que son el motivo de que el artículo sirva para algo), que
// prohíba inventar datos del negocio, y que el formato de salida sea el
// que espera WordPress al otro extremo.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({ fetch: vi.fn(), logError: vi.fn(), resolveActiveAnthropicCredentials: vi.fn() }));
vi.stubGlobal('fetch', mockState.fetch);
vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));
vi.mock('@/lib/anthropic-credentials', () => ({
  resolveActiveAnthropicCredentials: (...args: unknown[]) => mockState.resolveActiveAnthropicCredentials(...args),
}));

import {
  generateArticleDraft,
  parseArticleResponse,
  isSeoContentAIConfigured,
} from '@/lib/seo-content-ai';

const RESOLVED = { apiKey: 'sk-ant-test', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001' };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function articleJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: 'Cómo elegir un candado de alta seguridad',
    metaDescription: 'Qué mirar antes de comprar.',
    targetKeyword: 'candado alta seguridad',
    bodyHtml: '<h2>Qué mirar</h2><p>Lo primero es el arco.</p>',
    ...overrides,
  });
}

const INPUT = {
  businessName: 'Ferretería Central',
  businessDescription: 'Ferretería de barrio con más de 20 años.',
  targetAudience: 'Vecinos y pequeños talleres.',
  toneOfVoice: 'Cercano y directo.',
  siteUrl: 'https://ferreteriacentral.example',
  siteAudit: { title: 'Ferretería Central', h1Count: 1 },
  queryOpportunities: [
    { query: 'candado alta seguridad', impressions: 320, clicks: 4, position: 11.2 },
    { query: 'cerrajero urgente barrio', impressions: 120, clicks: 1, position: 8.7 },
  ],
};

async function promptFrom(input = INPUT): Promise<string> {
  mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
  mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: articleJson() }] }));
  await generateArticleDraft(input);
  return JSON.parse(mockState.fetch.mock.calls[0][1].body).system as string;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.logError.mockReset();
  mockState.resolveActiveAnthropicCredentials.mockReset().mockResolvedValue(null);
});

describe('isSeoContentAIConfigured', () => {
  it('depende de si hay una credencial resuelta', async () => {
    expect(await isSeoContentAIConfigured()).toBe(false);
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    expect(await isSeoContentAIConfigured()).toBe(true);
  });
});

describe('el prompt', () => {
  it('lleva las consultas reales por las que la web ya aparece', async () => {
    const prompt = await promptFrom();
    expect(prompt).toContain('candado alta seguridad');
    expect(prompt).toContain('posición media 11.2');
    expect(prompt).toContain('320 impresiones');
  });

  it('pide elegir UNA consulta como objetivo', async () => {
    expect(await promptFrom()).toContain('Elige UNA');
  });

  it('sin datos de Search Console, no finge que los hay', async () => {
    const prompt = await promptFrom({ ...INPUT, queryOpportunities: [] });
    expect(prompt).toContain('No hay todavía datos de Search Console');
  });

  it('prohíbe inventar datos del negocio y estadísticas', async () => {
    const prompt = await promptFrom();
    expect(prompt).toContain('NUNCA inventes datos del negocio');
    expect(prompt).toMatch(/estad[íi]sticas o estudios inventados/i);
  });

  it('lleva el contexto que dio el cliente en su alta', async () => {
    const prompt = await promptFrom();
    expect(prompt).toContain('Ferretería de barrio con más de 20 años.');
    expect(prompt).toContain('Vecinos y pequeños talleres.');
    expect(prompt).toContain('Cercano y directo.');
  });

  it('pide HTML de cuerpo, que es lo que publica WordPress, y prohíbe el h1', async () => {
    const prompt = await promptFrom();
    expect(prompt).toContain('HTML de cuerpo para WordPress');
    expect(prompt).toContain('NO incluyas <h1>');
  });

  it('no se rompe cuando el cliente dejó campos sin rellenar', async () => {
    const prompt = await promptFrom({
      ...INPUT, businessDescription: null, targetAudience: null, toneOfVoice: null, siteUrl: null,
    });
    expect(prompt).toContain('(no la ha dado)');
  });
});

describe('parseArticleResponse', () => {
  it('parsea un artículo completo', () => {
    expect(parseArticleResponse(articleJson())).toEqual({
      title: 'Cómo elegir un candado de alta seguridad',
      metaDescription: 'Qué mirar antes de comprar.',
      targetKeyword: 'candado alta seguridad',
      bodyHtml: '<h2>Qué mirar</h2><p>Lo primero es el arco.</p>',
    });
  });

  it('acepta la valla markdown', () => {
    expect(parseArticleResponse('```json\n' + articleJson() + '\n```')?.title).toBeTruthy();
  });

  it('exige título y cuerpo — sin ellos no hay nada que revisar', () => {
    expect(parseArticleResponse(articleJson({ title: '' }))).toBeNull();
    expect(parseArticleResponse(articleJson({ bodyHtml: undefined }))).toBeNull();
    expect(parseArticleResponse('no es json')).toBeNull();
  });

  it('tolera que falten los campos opcionales', () => {
    const parsed = parseArticleResponse(articleJson({ targetKeyword: undefined, metaDescription: undefined }));
    expect(parsed).toMatchObject({ targetKeyword: '', metaDescription: '' });
  });
});

describe('generateArticleDraft', () => {
  it('degrada sin clave y no llama a la red', async () => {
    expect(await generateArticleDraft(INPUT)).toEqual({ ok: true, skipped: true, reason: 'no_api_key' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('devuelve el artículo', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: articleJson() }] }));
    expect(await generateArticleDraft(INPUT)).toMatchObject({ ok: true, targetKeyword: 'candado alta seguridad' });
  });

  it('usa prefill para que la respuesta sea JSON y no una introducción en prosa', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    // Respuesta sin la llave inicial, tal y como la devuelve el prefill.
    mockState.fetch.mockResolvedValueOnce(jsonResponse({
      content: [{ type: 'text', text: '"title":"Un título","bodyHtml":"<p>Hola</p>"}' }],
    }));
    const result = await generateArticleDraft(INPUT);
    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body);
    expect(body.messages.at(-1)).toEqual({ role: 'assistant', content: '{' });
    expect(result).toMatchObject({ ok: true, title: 'Un título' });
  });

  it('devuelve error, sin lanzar, si la API falla', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: 'overloaded' }, false, 529));
    expect((await generateArticleDraft(INPUT)).ok).toBe(false);
  });

  it('devuelve error, sin lanzar, si se cae la red', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    expect((await generateArticleDraft(INPUT)).ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('devuelve error si el modelo no da JSON utilizable', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'Aquí tienes tu artículo:' }] }));
    expect(await generateArticleDraft(INPUT)).toEqual({ ok: false, error: 'anthropic_api_invalid_json' });
  });
});
