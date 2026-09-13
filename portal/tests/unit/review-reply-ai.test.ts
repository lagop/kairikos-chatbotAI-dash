// =============================================================================
// WP-22c — unit tests for src/lib/review-reply-ai.ts (Anthropic-backed
// draft generation — the first AI-provider integration in this repo).
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

import { isReviewReplyAIConfigured, generateReviewReplyDraft } from '@/lib/review-reply-ai';

const RESOLVED = { apiKey: 'sk-ant-test', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001' };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.logError.mockReset();
  mockState.resolveActiveAnthropicCredentials.mockReset().mockResolvedValue(null);
});

describe('isReviewReplyAIConfigured', () => {
  it('false when no credential is resolved', async () => {
    expect(await isReviewReplyAIConfigured()).toBe(false);
  });

  it('true when a credential resolves', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    expect(await isReviewReplyAIConfigured()).toBe(true);
  });
});

describe('generateReviewReplyDraft', () => {
  it('skips with no_api_key when unconfigured — never calls fetch', async () => {
    const result = await generateReviewReplyDraft({ businessName: 'X', reviewerName: 'Ana', starRating: 5, comment: 'Genial' });
    expect(result).toEqual({ ok: true, skipped: true, reason: 'no_api_key' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('returns the generated draft text on success', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: 'text', text: '¡Gracias por tu reseña, Ana!' }] }),
    );
    const result = await generateReviewReplyDraft({ businessName: 'Clínica Orly', reviewerName: 'Ana', starRating: 5, comment: 'Genial' });
    expect(result).toEqual({ ok: true, draft: '¡Gracias por tu reseña, Ana!' });
  });

  it('sends the x-api-key and anthropic-version headers, against the resolved base URL', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    await generateReviewReplyDraft({ businessName: 'X', reviewerName: null, starRating: 3, comment: null });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBeTruthy();
  });

  it('uses a custom resolved base URL and model when set', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce({
      apiKey: 'sk-ant-test',
      baseUrl: 'https://proxy.example.com',
      model: 'claude-opus-5',
    });
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    await generateReviewReplyDraft({ businessName: 'X', reviewerName: null, starRating: 3, comment: null });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(String(url)).toBe('https://proxy.example.com/v1/messages');
    expect(JSON.parse(init.body).model).toBe('claude-opus-5');
  });

  it('includes a negative-review-specific instruction (empathetic, no compensation promises) for low ratings', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    await generateReviewReplyDraft({ businessName: 'X', reviewerName: null, starRating: 1, comment: 'Mala experiencia' });
    const [, init] = mockState.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system).toContain('negativa');
    expect(body.system).not.toContain('positiva');
  });

  it('returns an error result (not a throw) on a non-ok API response', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, false, 429));
    const result = await generateReviewReplyDraft({ businessName: 'X', reviewerName: null, starRating: 5, comment: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('429');
  });

  it('returns an error result on a network failure, never throws', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await generateReviewReplyDraft({ businessName: 'X', reviewerName: null, starRating: 5, comment: null });
    expect(result.ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('returns an error when the API response has no text content block', async () => {
    mockState.resolveActiveAnthropicCredentials.mockResolvedValueOnce(RESOLVED);
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [] }));
    const result = await generateReviewReplyDraft({ businessName: 'X', reviewerName: null, starRating: 5, comment: null });
    expect(result).toEqual({ ok: false, error: 'anthropic_api_empty_response' });
  });
});
