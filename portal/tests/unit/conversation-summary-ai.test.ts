// =============================================================================
// Canales Fase 7 — unit tests for src/lib/conversation-summary-ai.ts.
// Mirrors tests/unit/review-reply-ai.test.ts (same Anthropic-fetch
// pattern) plus dedicated coverage for parseDigestResponse, since this
// generator (unlike review-reply-ai) needs strict JSON, not free text.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  fetch: vi.fn(),
  logError: vi.fn(),
}));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import {
  isConversationSummaryAIConfigured,
  generateConversationDigest,
  parseDigestResponse,
} from '@/lib/conversation-summary-ai';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.logError.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe('isConversationSummaryAIConfigured', () => {
  it('false when ANTHROPIC_API_KEY is unset', () => {
    expect(isConversationSummaryAIConfigured()).toBe(false);
  });

  it('true when set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(isConversationSummaryAIConfigured()).toBe(true);
  });
});

describe('parseDigestResponse', () => {
  it('parses a well-formed response', () => {
    const parsed = parseDigestResponse('{"summaryText": "Todo bien", "highlights": ["Pidieron precio"]}');
    expect(parsed).toEqual({ summaryText: 'Todo bien', highlights: ['Pidieron precio'] });
  });

  it('returns null on malformed JSON', () => {
    expect(parseDigestResponse('not json')).toBeNull();
  });

  it('returns null when summaryText is missing', () => {
    expect(parseDigestResponse('{"highlights": []}')).toBeNull();
  });

  it('defaults highlights to [] when absent or not an array', () => {
    expect(parseDigestResponse('{"summaryText": "ok"}')).toEqual({ summaryText: 'ok', highlights: [] });
    expect(parseDigestResponse('{"summaryText": "ok", "highlights": "not an array"}')).toEqual({
      summaryText: 'ok',
      highlights: [],
    });
  });

  it('filters out non-string highlight entries and caps at 8', () => {
    const highlights = Array.from({ length: 10 }, (_, i) => `h${i}`);
    const parsed = parseDigestResponse(JSON.stringify({ summaryText: 'ok', highlights: [...highlights, 42, null] }));
    expect(parsed?.highlights).toHaveLength(8);
    expect(parsed?.highlights[0]).toBe('h0');
  });
});

describe('generateConversationDigest', () => {
  const baseInput = {
    businessName: 'Clínica Orly',
    conversations: [
      { startedAt: new Date('2026-08-19T09:00:00Z'), outcome: 'resolved', duration: 120, transcript: [{ role: 'user', content: 'Hola' }] },
    ],
  };

  it('skips with no_api_key when unset — never calls fetch', async () => {
    const result = await generateConversationDigest(baseInput);
    expect(result).toEqual({ ok: true, skipped: true, reason: 'no_api_key' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('returns the parsed summary and highlights on success', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: 'text', text: '{"summaryText": "Resumen ok", "highlights": ["Atender a Ana"]}' }] }),
    );
    const result = await generateConversationDigest(baseInput);
    expect(result).toEqual({ ok: true, summaryText: 'Resumen ok', highlights: ['Atender a Ana'] });
  });

  it('sends the x-api-key and anthropic-version headers', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: '{"summaryText": "ok", "highlights": []}' }] }));
    await generateConversationDigest(baseInput);
    const [, init] = mockState.fetch.mock.calls[0];
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBeTruthy();
  });

  it('caps the number of conversations included in the prompt and notes the omitted count', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: '{"summaryText": "ok", "highlights": []}' }] }));
    const many = Array.from({ length: 45 }, (_, i) => ({
      startedAt: new Date(),
      outcome: 'resolved',
      duration: 10,
      transcript: null,
    }));
    await generateConversationDigest({ businessName: 'X', conversations: many });
    const [, init] = mockState.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    const userContent = body.messages[0].content as string;
    expect(userContent).toContain('hay 5 más no incluidas');
  });

  it('returns an error result (not a throw) on a non-ok API response', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, false, 429));
    const result = await generateConversationDigest(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('429');
  });

  it('returns an error result on a network failure, never throws', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await generateConversationDigest(baseInput);
    expect(result.ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('returns anthropic_api_invalid_json when the model does not return valid JSON', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'not json at all' }] }));
    const result = await generateConversationDigest(baseInput);
    expect(result).toEqual({ ok: false, error: 'anthropic_api_invalid_json' });
  });

  it('returns an error when the API response has no text content block', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [] }));
    const result = await generateConversationDigest(baseInput);
    expect(result).toEqual({ ok: false, error: 'anthropic_api_empty_response' });
  });
});
