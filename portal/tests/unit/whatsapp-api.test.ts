// =============================================================================
// Canales — unit tests for src/lib/whatsapp-api.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({ fetch: vi.fn(), logError: vi.fn() }));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { subscribeWaba, unsubscribeWaba, sendMessage } from '@/lib/whatsapp-api';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.logError.mockReset();
  delete process.env.META_GRAPH_API_VERSION;
});

describe('subscribeWaba', () => {
  it('POSTs to /{wabaId}/subscribed_apps with the access token as a query param', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    const result = await subscribeWaba('token-abc', 'waba_123');
    expect(result).toEqual({ ok: true, data: { success: true } });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toContain('/waba_123/subscribed_apps');
    expect(url).toContain('access_token=token-abc');
    expect(init.method).toBe('POST');
  });

  it('returns an error result when Meta rejects the subscription', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid OAuth access token' } }));
    const result = await subscribeWaba('bad-token', 'waba_123');
    expect(result).toEqual({ ok: false, error: 'Invalid OAuth access token' });
  });

  it('returns an error result on a network failure, never throws', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await subscribeWaba('token', 'waba_123');
    expect(result.ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });
});

describe('unsubscribeWaba', () => {
  it('DELETEs /{wabaId}/subscribed_apps', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ success: true }));
    const result = await unsubscribeWaba('token-abc', 'waba_123');
    expect(result).toEqual({ ok: true, data: { success: true } });
    const [, init] = mockState.fetch.mock.calls[0];
    expect(init.method).toBe('DELETE');
  });
});

describe('sendMessage', () => {
  it('sends a well-formed WhatsApp Cloud API text message payload', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.abc' }] }));
    const result = await sendMessage('token-abc', 'phone_1', '34600000000', 'Hola, ¿en qué puedo ayudarte?');
    expect(result).toEqual({ ok: true, data: { messages: [{ id: 'wamid.abc' }] } });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toContain('/phone_1/messages');
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: 'whatsapp',
      to: '34600000000',
      type: 'text',
      text: { body: 'Hola, ¿en qué puedo ayudarte?' },
    });
  });

  it('returns an error result when Meta rejects the send', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: { message: '24 hour window expired' } }));
    const result = await sendMessage('token', 'phone_1', '34600000000', 'hola');
    expect(result).toEqual({ ok: false, error: '24 hour window expired' });
  });
});
