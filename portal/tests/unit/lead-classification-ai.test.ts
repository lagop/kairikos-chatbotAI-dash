// =============================================================================
// "Sistema IA de captación" — unit tests for src/lib/lead-classification-ai.ts.
// Mirrors tests/unit/conversation-summary-ai.test.ts (same Anthropic-fetch
// pattern, same reason for isolating the JSON-parse function from network).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  fetch: vi.fn(),
  logError: vi.fn(),
  resolveActiveAnthropicCredentials: vi.fn(),
}));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

vi.mock('@/lib/anthropic-credentials', () => ({
  resolveActiveAnthropicCredentials: (...args: unknown[]) => mockState.resolveActiveAnthropicCredentials(...args),
}));

import {
  isLeadClassificationConfigured,
  classifyConversationForLead,
  parseLeadClassificationResponse,
} from '@/lib/lead-classification-ai';

const RESOLVED = { apiKey: 'sk-ant-test', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001' };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.logError.mockReset();
  mockState.resolveActiveAnthropicCredentials.mockReset().mockResolvedValue(null);
});

describe('isLeadClassificationConfigured', () => {
  it('false when no credential is resolved', async () => {
    expect(await isLeadClassificationConfigured()).toBe(false);
  });

  it('true when a credential resolves', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    expect(await isLeadClassificationConfigured()).toBe(true);
  });
});

describe('parseLeadClassificationResponse', () => {
  it('parses a well-formed lead response', () => {
    const parsed = parseLeadClassificationResponse(
      JSON.stringify({
        isLead: true,
        score: 85,
        scoreReason: 'Pregunta precio y quiere cita esta semana',
        contactName: 'Ana',
        contactPhone: '+34600000000',
        contactEmail: null,
        summary: 'Quiere una reforma de baño',
      }),
    );
    expect(parsed).toEqual({
      isLead: true,
      score: 85,
      scoreReason: 'Pregunta precio y quiere cita esta semana',
      contactName: 'Ana',
      contactPhone: '+34600000000',
      contactEmail: null,
      summary: 'Quiere una reforma de baño',
    });
  });

  it('parses a well-formed non-lead response', () => {
    const parsed = parseLeadClassificationResponse(
      JSON.stringify({ isLead: false, score: 0, scoreReason: 'Solo saludó, sin interés comercial' }),
    );
    expect(parsed).toEqual({
      isLead: false,
      score: 0,
      scoreReason: 'Solo saludó, sin interés comercial',
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      summary: null,
    });
  });

  it('returns null on malformed JSON', () => {
    expect(parseLeadClassificationResponse('not json')).toBeNull();
  });

  it('strips a wrapping ```json code fence before parsing (found live against the real Anthropic API)', () => {
    const parsed = parseLeadClassificationResponse(
      '```json\n{"isLead": true, "score": 85, "scoreReason": "quiere presupuesto", "contactName": "Jordi Pla"}\n```',
    );
    expect(parsed).toEqual({
      isLead: true,
      score: 85,
      scoreReason: 'quiere presupuesto',
      contactName: 'Jordi Pla',
      contactPhone: null,
      contactEmail: null,
      summary: null,
    });
  });

  it('strips a bare ``` fence (no json language tag) before parsing', () => {
    const parsed = parseLeadClassificationResponse('```\n{"isLead": false, "score": 0, "scoreReason": "x"}\n```');
    expect(parsed?.isLead).toBe(false);
  });

  it('returns null when isLead is missing or not boolean', () => {
    expect(parseLeadClassificationResponse('{"score": 50, "scoreReason": "x"}')).toBeNull();
    expect(parseLeadClassificationResponse('{"isLead": "yes", "scoreReason": "x"}')).toBeNull();
  });

  it('returns null when scoreReason is missing', () => {
    expect(parseLeadClassificationResponse('{"isLead": true, "score": 50}')).toBeNull();
  });

  it('forces score to 0 and summary to null when isLead is false, even if the model sent otherwise', () => {
    const parsed = parseLeadClassificationResponse(
      JSON.stringify({ isLead: false, score: 90, scoreReason: 'x', summary: 'no debería aparecer' }),
    );
    expect(parsed?.score).toBe(0);
    expect(parsed?.summary).toBeNull();
  });

  it('clamps score into 0-100 and rounds it', () => {
    expect(parseLeadClassificationResponse('{"isLead": true, "score": 150, "scoreReason": "x"}')?.score).toBe(100);
    expect(parseLeadClassificationResponse('{"isLead": true, "score": -5, "scoreReason": "x"}')?.score).toBe(0);
    expect(parseLeadClassificationResponse('{"isLead": true, "score": 42.6, "scoreReason": "x"}')?.score).toBe(43);
  });

  it('treats blank contact fields as null, never as empty strings', () => {
    const parsed = parseLeadClassificationResponse(
      JSON.stringify({ isLead: true, score: 10, scoreReason: 'x', contactName: '   ', contactEmail: 42 }),
    );
    expect(parsed?.contactName).toBeNull();
    expect(parsed?.contactEmail).toBeNull();
  });
});

describe('classifyConversationForLead', () => {
  const baseInput = {
    businessName: 'Reformas Orly',
    qualification: { perfilClienteIdeal: 'dueños de local con presupuesto decidido', senalesDescarte: 'busca empleo' },
    outcome: 'resolved',
    transcript: [{ role: 'user', content: '¿Cuánto cuesta reformar un baño?' }],
  };

  it('skips with no_api_key when unset — never calls fetch', async () => {
    const result = await classifyConversationForLead(baseInput);
    expect(result).toEqual({ ok: true, skipped: true, reason: 'no_api_key' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('returns the parsed classification on success', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({
        content: [{ type: 'text', text: '{"isLead": true, "score": 80, "scoreReason": "quiere presupuesto"}' }],
      }),
    );
    const result = await classifyConversationForLead(baseInput);
    expect(result).toEqual({
      ok: true,
      isLead: true,
      score: 80,
      scoreReason: 'quiere presupuesto',
      contactName: null,
      contactPhone: null,
      contactEmail: null,
      summary: null,
    });
  });

  it('includes the qualification profile in the prompt when present', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: 'text', text: '{"isLead": false, "score": 0, "scoreReason": "x"}' }] }),
    );
    await classifyConversationForLead(baseInput);
    const [, init] = mockState.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system).toContain('dueños de local con presupuesto decidido');
    expect(body.system).toContain('busca empleo');
  });

  it('falls back to generic guidance when the client has no qualification profile', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: 'text', text: '{"isLead": false, "score": 0, "scoreReason": "x"}' }] }),
    );
    await classifyConversationForLead({ ...baseInput, qualification: null });
    const [, init] = mockState.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system).toContain('no ha descrito todavía a su cliente ideal');
  });

  // Fase 2.3 — el bucle de aprendizaje: los leads que el propio cliente ya
  // cerró son la señal más honesta de qué le sirve.
  it('mete en el prompt los leads que el cliente ya cerró, con su veredicto', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: 'text', text: '{"isLead": false, "score": 0, "scoreReason": "x"}' }] }),
    );
    await classifyConversationForLead({
      ...baseInput,
      examples: [
        { summary: 'Pidió presupuesto para reforma completa y firmó', converted: true },
        { summary: 'Solo preguntaba por trabajar con nosotros', converted: false },
      ],
    });
    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body);
    expect(body.system).toContain('SE CONVIRTIÓ en cliente: Pidió presupuesto para reforma completa y firmó');
    expect(body.system).toContain('NO llegó a nada: Solo preguntaba por trabajar con nosotros');
    expect(body.system).toContain('calibrar la puntuación');
  });

  it('sin histórico, el prompt queda como antes — es el estado normal de un cliente nuevo', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: 'text', text: '{"isLead": false, "score": 0, "scoreReason": "x"}' }] }),
    );
    await classifyConversationForLead({ ...baseInput, examples: [] });
    const body = JSON.parse(mockState.fetch.mock.calls[0][1].body);
    expect(body.system).not.toContain('SE CONVIRTIÓ');
    expect(body.system).not.toContain('calibrar la puntuación');
  });

  it('sends the x-api-key and anthropic-version headers', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: 'text', text: '{"isLead": false, "score": 0, "scoreReason": "x"}' }] }),
    );
    await classifyConversationForLead(baseInput);
    const [, init] = mockState.fetch.mock.calls[0];
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBeTruthy();
  });

  it('returns an error result (not a throw) on a non-ok API response', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, false, 429));
    const result = await classifyConversationForLead(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('429');
  });

  it('returns an error result on a network failure, never throws', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await classifyConversationForLead(baseInput);
    expect(result.ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('returns anthropic_api_invalid_json when the model does not return valid JSON', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'not json at all' }] }));
    const result = await classifyConversationForLead(baseInput);
    expect(result).toEqual({ ok: false, error: 'anthropic_api_invalid_json' });
  });

  it('returns an error when the API response has no text content block', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [] }));
    const result = await classifyConversationForLead(baseInput);
    expect(result).toEqual({ ok: false, error: 'anthropic_api_empty_response' });
  });
});
