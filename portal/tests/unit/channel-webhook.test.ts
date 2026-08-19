// =============================================================================
// WP: conexión de canales — unit tests for src/lib/channel-webhook.ts.
//
// Covers: the immediate-delivery path (success and failure both audit a
// ChannelWebhookDelivery row), the manual/cron retry path, the backoff
// window computation, and the MAX_ATTEMPTS ceiling that hands a delivery
// off to the operator's manual retry instead of retrying forever.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  fetch: vi.fn(),
  deliveryCreate: vi.fn(),
  deliveryUpdate: vi.fn(),
  deliveryFindUnique: vi.fn(),
  deliveryFindMany: vi.fn(),
  logError: vi.fn(),
}));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    channelWebhookDelivery: {
      create: (...args: unknown[]) => mockState.deliveryCreate(...args),
      update: (...args: unknown[]) => mockState.deliveryUpdate(...args),
      findUnique: (...args: unknown[]) => mockState.deliveryFindUnique(...args),
      findMany: (...args: unknown[]) => mockState.deliveryFindMany(...args),
    },
  },
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import {
  deliverChannelEvent,
  retryChannelWebhookDelivery,
  retryPendingChannelWebhooks,
} from '@/lib/channel-webhook';

function jsonResponse(ok = true, status = 200, text = '') {
  return { ok, status, text: async () => text } as unknown as Response;
}

const ENV_KEYS = ['N8N_CHANNEL_WEBHOOK_URL', 'N8N_CHANNEL_WEBHOOK_SECRET'] as const;

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.deliveryCreate.mockReset();
  mockState.deliveryUpdate.mockReset().mockResolvedValue({});
  mockState.deliveryFindUnique.mockReset();
  mockState.deliveryFindMany.mockReset().mockResolvedValue([]);
  mockState.logError.mockReset();
  process.env.N8N_CHANNEL_WEBHOOK_URL = 'https://n8n.kairikos.test/webhook/channels';
  process.env.N8N_CHANNEL_WEBHOOK_SECRET = 'shhh-secret';
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

const baseEvent = {
  connectionType: 'telegram' as const,
  connectionId: 'conn_1',
  clientId: 'client_1',
  payload: { event: 'connected', botUsername: 'kairikos_bot' },
};

describe('deliverChannelEvent', () => {
  it('creates a delivery row up front and marks it delivered on 2xx', async () => {
    mockState.deliveryCreate.mockResolvedValue({ id: 'dlv_1' });
    mockState.fetch.mockResolvedValue(jsonResponse(true, 200));

    const result = await deliverChannelEvent(baseEvent);

    expect(mockState.deliveryCreate).toHaveBeenCalledWith({
      data: {
        connectionType: 'telegram',
        connectionId: 'conn_1',
        clientId: 'client_1',
        payload: baseEvent.payload,
        status: 'pending',
      },
    });
    expect(mockState.fetch).toHaveBeenCalledWith(
      'https://n8n.kairikos.test/webhook/channels',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-kairikos-internal-key': 'shhh-secret' }),
      }),
    );
    expect(mockState.deliveryUpdate).toHaveBeenCalledWith({
      where: { id: 'dlv_1' },
      data: expect.objectContaining({ status: 'delivered', attempts: 1 }),
    });
    expect(result).toEqual({ ok: true, deliveryId: 'dlv_1', status: 'delivered' });
  });

  it('marks the row failed on a non-2xx response and never throws', async () => {
    mockState.deliveryCreate.mockResolvedValue({ id: 'dlv_2' });
    mockState.fetch.mockResolvedValue(jsonResponse(false, 500, 'internal error'));

    const result = await deliverChannelEvent(baseEvent);

    expect(mockState.deliveryUpdate).toHaveBeenCalledWith({
      where: { id: 'dlv_2' },
      data: expect.objectContaining({ status: 'failed', attempts: 1, lastError: expect.stringContaining('webhook_error:500') }),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('marks the row failed on a network error and never throws', async () => {
    mockState.deliveryCreate.mockResolvedValue({ id: 'dlv_3' });
    mockState.fetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await deliverChannelEvent(baseEvent);

    expect(result.ok).toBe(false);
    expect(mockState.deliveryUpdate).toHaveBeenCalledWith({
      where: { id: 'dlv_3' },
      data: expect.objectContaining({ status: 'failed', lastError: 'ECONNREFUSED' }),
    });
  });

  it('marks the row failed without calling fetch when the bridge is unconfigured', async () => {
    delete process.env.N8N_CHANNEL_WEBHOOK_URL;
    mockState.deliveryCreate.mockResolvedValue({ id: 'dlv_4' });

    const result = await deliverChannelEvent(baseEvent);

    expect(mockState.fetch).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not_configured');
  });
});

describe('retryChannelWebhookDelivery', () => {
  it('returns delivery_not_found for an unknown id', async () => {
    mockState.deliveryFindUnique.mockResolvedValue(null);
    const result = await retryChannelWebhookDelivery('missing');
    expect(result).toEqual({ ok: false, deliveryId: 'missing', status: 'failed', error: 'delivery_not_found' });
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('increments attempts and flips to delivered on success', async () => {
    mockState.deliveryFindUnique.mockResolvedValue({
      id: 'dlv_5',
      connectionType: 'meta',
      connectionId: 'conn_2',
      clientId: 'client_2',
      payload: { event: 'connected' },
      attempts: 2,
    });
    mockState.fetch.mockResolvedValue(jsonResponse(true, 200));

    const result = await retryChannelWebhookDelivery('dlv_5');

    expect(mockState.deliveryUpdate).toHaveBeenCalledWith({
      where: { id: 'dlv_5' },
      data: expect.objectContaining({ status: 'delivered', attempts: 3, lastError: null }),
    });
    expect(result.ok).toBe(true);
  });

  it('increments attempts and stays failed on another failure', async () => {
    mockState.deliveryFindUnique.mockResolvedValue({
      id: 'dlv_6',
      connectionType: 'meta',
      connectionId: 'conn_3',
      clientId: 'client_3',
      payload: {},
      attempts: 1,
    });
    mockState.fetch.mockResolvedValue(jsonResponse(false, 503, 'unavailable'));

    const result = await retryChannelWebhookDelivery('dlv_6');

    expect(mockState.deliveryUpdate).toHaveBeenCalledWith({
      where: { id: 'dlv_6' },
      data: expect.objectContaining({ status: 'failed', attempts: 2 }),
    });
    expect(result.ok).toBe(false);
  });
});

describe('retryPendingChannelWebhooks', () => {
  it('skips the sweep entirely when unconfigured, without querying the DB', async () => {
    delete process.env.N8N_CHANNEL_WEBHOOK_SECRET;
    const result = await retryPendingChannelWebhooks();
    expect(result).toEqual({ scanned: 0, delivered: 0, stillFailed: 0, skippedNotConfigured: true });
    expect(mockState.deliveryFindMany).not.toHaveBeenCalled();
  });

  it('queries only failed deliveries under the attempt ceiling', async () => {
    mockState.deliveryFindMany.mockResolvedValue([]);
    await retryPendingChannelWebhooks();
    expect(mockState.deliveryFindMany).toHaveBeenCalledWith({
      where: { status: 'failed', attempts: { lt: 6 } },
      orderBy: { lastAttemptAt: 'asc' },
    });
  });

  it('retries a delivery with no lastAttemptAt immediately (never attempted a retry yet)', async () => {
    mockState.deliveryFindMany.mockResolvedValue([
      { id: 'dlv_7', connectionType: 'web', connectionId: 'c1', clientId: 'client_1', payload: {}, attempts: 1, lastAttemptAt: null },
    ]);
    mockState.deliveryFindUnique.mockResolvedValue({
      id: 'dlv_7',
      connectionType: 'web',
      connectionId: 'c1',
      clientId: 'client_1',
      payload: {},
      attempts: 1,
    });
    mockState.fetch.mockResolvedValue(jsonResponse(true, 200));

    const result = await retryPendingChannelWebhooks();

    expect(result.scanned).toBe(1);
    expect(result.delivered).toBe(1);
  });

  it('skips a delivery whose backoff window has not elapsed yet', async () => {
    const recentAttempt = new Date(Date.now() - 60_000); // 1 minute ago; backoff after 1 attempt is 5 minutes
    mockState.deliveryFindMany.mockResolvedValue([
      { id: 'dlv_8', connectionType: 'web', connectionId: 'c2', clientId: 'client_2', payload: {}, attempts: 1, lastAttemptAt: recentAttempt },
    ]);

    const result = await retryPendingChannelWebhooks();

    expect(result.scanned).toBe(0);
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('retries a delivery whose backoff window has elapsed', async () => {
    const oldAttempt = new Date(Date.now() - 10 * 60_000); // 10 minutes ago; backoff after 1 attempt is 5 minutes
    mockState.deliveryFindMany.mockResolvedValue([
      { id: 'dlv_9', connectionType: 'web', connectionId: 'c3', clientId: 'client_3', payload: {}, attempts: 1, lastAttemptAt: oldAttempt },
    ]);
    mockState.deliveryFindUnique.mockResolvedValue({
      id: 'dlv_9',
      connectionType: 'web',
      connectionId: 'c3',
      clientId: 'client_3',
      payload: {},
      attempts: 1,
    });
    mockState.fetch.mockResolvedValue(jsonResponse(false, 500, 'boom'));

    const result = await retryPendingChannelWebhooks();

    expect(result.scanned).toBe(1);
    expect(result.stillFailed).toBe(1);
  });
});
