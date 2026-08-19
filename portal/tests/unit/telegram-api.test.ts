// =============================================================================
// Canales — unit tests for src/lib/telegram-api.ts. Thin fetch wrapper
// around the Bot API — these tests exercise the URL construction,
// success/error shape, and the never-throws contract.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({ fetch: vi.fn(), logError: vi.fn() }));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { setWebhook, deleteWebhook, sendMessage } from '@/lib/telegram-api';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.logError.mockReset();
});

describe('setWebhook', () => {
  it('POSTs to the correct Bot API URL with the webhook url in the body', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const result = await setWebhook('123:abc', 'https://n8n.example.com/webhook/kairikos-telegram/conn_1');
    expect(result).toEqual({ ok: true, data: true });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bot123:abc/setWebhook');
    expect(JSON.parse(init.body)).toEqual({ url: 'https://n8n.example.com/webhook/kairikos-telegram/conn_1' });
  });

  it('returns an error result (not a throw) when Telegram rejects the call', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ ok: false, description: 'bad webhook: HTTPS url must be provided' }, false, 400));
    const result = await setWebhook('123:abc', 'http://insecure.example.com/hook');
    expect(result).toEqual({ ok: false, error: 'bad webhook: HTTPS url must be provided' });
  });

  it('returns an error result on a network failure, never throws', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await setWebhook('123:abc', 'https://n8n.example.com/hook');
    expect(result.ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });
});

describe('deleteWebhook', () => {
  it('POSTs to the deleteWebhook endpoint', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ ok: true, result: true }));
    const result = await deleteWebhook('123:abc');
    expect(result).toEqual({ ok: true, data: true });
    expect(mockState.fetch.mock.calls[0][0]).toBe('https://api.telegram.org/bot123:abc/deleteWebhook');
  });
});

describe('sendMessage', () => {
  it('sends chat_id and text in the request body', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 42 } }));
    const result = await sendMessage('123:abc', 987654, 'Hola, ¿en qué puedo ayudarte?');
    expect(result).toEqual({ ok: true, data: { message_id: 42 } });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    expect(JSON.parse(init.body)).toEqual({ chat_id: 987654, text: 'Hola, ¿en qué puedo ayudarte?' });
  });

  it('returns an error result when the chat no longer exists (e.g. user blocked the bot)', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ ok: false, description: 'Forbidden: bot was blocked by the user' }, false, 403));
    const result = await sendMessage('123:abc', 987654, 'hola');
    expect(result).toEqual({ ok: false, error: 'Forbidden: bot was blocked by the user' });
  });
});
