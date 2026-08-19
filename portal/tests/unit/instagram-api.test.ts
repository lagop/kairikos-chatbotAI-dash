// =============================================================================
// Canales — unit tests for src/lib/instagram-api.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({ fetch: vi.fn(), logError: vi.fn() }));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import { sendMessage } from '@/lib/instagram-api';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.logError.mockReset();
});

describe('sendMessage', () => {
  it('sends a well-formed Instagram Messaging API payload', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ message_id: 'mid.abc' }));
    const result = await sendMessage('token-abc', 'ig_123', 'ig_sender_1', 'Hola, ¿en qué puedo ayudarte?');
    expect(result).toEqual({ ok: true, data: { message_id: 'mid.abc' } });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toContain('/ig_123/messages');
    expect(JSON.parse(init.body)).toEqual({
      recipient: { id: 'ig_sender_1' },
      message: { text: 'Hola, ¿en qué puedo ayudarte?' },
    });
  });

  it('returns an error result when Meta rejects the send', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'Outside 24 hour window' } }));
    const result = await sendMessage('token', 'ig_123', 'ig_sender_1', 'hola');
    expect(result).toEqual({ ok: false, error: 'Outside 24 hour window' });
  });

  it('never throws on a network failure', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await sendMessage('token', 'ig_123', 'ig_sender_1', 'hola');
    expect(result.ok).toBe(false);
    expect(mockState.logError).toHaveBeenCalled();
  });
});
