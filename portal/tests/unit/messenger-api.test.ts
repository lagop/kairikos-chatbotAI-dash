// =============================================================================
// Canales — unit tests for src/lib/messenger-api.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({ fetch: vi.fn(), logError: vi.fn() }));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { subscribePage, sendMessage } from '@/lib/messenger-api';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.logError.mockReset();
});

describe('subscribePage', () => {
  it('POSTs to /{pageId}/subscribed_apps with messages+messaging_postbacks fields', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    const result = await subscribePage('page-token', 'page_123');
    expect(result).toEqual({ ok: true, data: { success: true } });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toContain('/page_123/subscribed_apps');
    expect(JSON.parse(init.body)).toEqual({ subscribed_fields: 'messages,messaging_postbacks' });
  });

  it('returns an error result when Meta rejects the subscription', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid OAuth access token' } }));
    const result = await subscribePage('bad-token', 'page_123');
    expect(result).toEqual({ ok: false, error: 'Invalid OAuth access token' });
  });

  it('never throws on a network failure', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await subscribePage('token', 'page_123');
    expect(result.ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });
});

describe('sendMessage', () => {
  it('sends a well-formed Messenger Send API payload', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ message_id: 'mid.abc' }));
    const result = await sendMessage('page-token', 'page_123', 'psid_1', 'Hola, ¿en qué puedo ayudarte?');
    expect(result).toEqual({ ok: true, data: { message_id: 'mid.abc' } });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toContain('/page_123/messages');
    expect(JSON.parse(init.body)).toEqual({
      recipient: { id: 'psid_1' },
      message: { text: 'Hola, ¿en qué puedo ayudarte?' },
    });
  });

  it('returns an error result when Meta rejects the send', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'This person is not available right now' } }));
    const result = await sendMessage('token', 'page_123', 'psid_1', 'hola');
    expect(result).toEqual({ ok: false, error: 'This person is not available right now' });
  });
});
