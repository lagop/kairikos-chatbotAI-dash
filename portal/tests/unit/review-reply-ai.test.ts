// =============================================================================
// WP-22c — unit tests for src/lib/review-reply-ai.ts (Anthropic-backed
// draft generation — the first AI-provider integration in this repo).
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

import { isReviewReplyAIConfigured, generateReviewReplyDraft } from '@/lib/review-reply-ai';

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

describe('isReviewReplyAIConfigured', () => {
  it('false when ANTHROPIC_API_KEY is unset', () => {
    expect(isReviewReplyAIConfigured()).toBe(false);
  });

  it('true when set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(isReviewReplyAIConfigured()).toBe(true);
  });
});

describe('generateReviewReplyDraft', () => {
  it('skips with no_api_key when unset — never calls fetch', async () => {
    const result = await generateReviewReplyDraft({ businessName: 'X', reviewerName: 'Ana', starRating: 5, comment: 'Genial' });
    expect(result).toEqual({ ok: true, skipped: true, reason: 'no_api_key' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('returns the generated draft text on success', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ content: [{ type: 'text', text: '¡Gracias por tu reseña, Ana!' }] }),
    );
    const result = await generateReviewReplyDraft({ businessName: 'Clínica Orly', reviewerName: 'Ana', starRating: 5, comment: 'Genial' });
    expect(result).toEqual({ ok: true, draft: '¡Gracias por tu reseña, Ana!' });
  });

  it('sends the x-api-key and anthropic-version headers', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    await generateReviewReplyDraft({ businessName: 'X', reviewerName: null, starRating: 3, comment: null });
    const [, init] = mockState.fetch.mock.calls[0];
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBeTruthy();
  });

  it('includes a negative-review-specific instruction (empathetic, no compensation promises) for low ratings', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    await generateReviewReplyDraft({ businessName: 'X', reviewerName: null, starRating: 1, comment: 'Mala experiencia' });
    const [, init] = mockState.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system).toContain('negativa');
    expect(body.system).not.toContain('positiva');
  });

  it('returns an error result (not a throw) on a non-ok API response', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, false, 429));
    const result = await generateReviewReplyDraft({ businessName: 'X', reviewerName: null, starRating: 5, comment: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('429');
  });

  it('returns an error result on a network failure, never throws', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await generateReviewReplyDraft({ businessName: 'X', reviewerName: null, starRating: 5, comment: null });
    expect(result.ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('returns an error when the API response has no text content block', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ content: [] }));
    const result = await generateReviewReplyDraft({ businessName: 'X', reviewerName: null, starRating: 5, comment: null });
    expect(result).toEqual({ ok: false, error: 'anthropic_api_empty_response' });
  });
});
