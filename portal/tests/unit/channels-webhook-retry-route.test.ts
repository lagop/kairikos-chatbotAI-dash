// =============================================================================
// WP: conexión de canales — Fase 5. Unit tests for
// POST /api/admin/portal/channels/webhook-deliveries/[id]/retry.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  retryChannelWebhookDelivery: vi.fn(),
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/channel-webhook', () => ({
  retryChannelWebhookDelivery: (...args: unknown[]) => mockState.retryChannelWebhookDelivery(...args),
}));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
}));

function fakeRequest(): NextRequest {
  return {} as unknown as NextRequest;
}

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, operatorId: 'op_1' });
  mockState.retryChannelWebhookDelivery
    .mockReset()
    .mockResolvedValue({ ok: true, deliveryId: 'dlv_1', status: 'delivered' });
  mockState.isDatabaseConfigured = true;
});

describe('POST /api/admin/portal/channels/webhook-deliveries/[id]/retry', () => {
  it('401s without a valid operator session', async () => {
    mockState.authenticateAdminRequest.mockResolvedValue({ ok: false });
    const { POST } = await import('@/app/api/admin/portal/channels/webhook-deliveries/[id]/retry/route');
    const res = await POST(fakeRequest(), { params: { id: 'dlv_1' } });
    expect(res.status).toBe(401);
    expect(mockState.retryChannelWebhookDelivery).not.toHaveBeenCalled();
  });

  it('503s when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    const { POST } = await import('@/app/api/admin/portal/channels/webhook-deliveries/[id]/retry/route');
    const res = await POST(fakeRequest(), { params: { id: 'dlv_1' } });
    expect(res.status).toBe(503);
  });

  it('404s when the delivery does not exist', async () => {
    mockState.retryChannelWebhookDelivery.mockResolvedValue({
      ok: false,
      deliveryId: 'missing',
      status: 'failed',
      error: 'delivery_not_found',
    });
    const { POST } = await import('@/app/api/admin/portal/channels/webhook-deliveries/[id]/retry/route');
    const res = await POST(fakeRequest(), { params: { id: 'missing' } });
    expect(res.status).toBe(404);
  });

  it('retries and returns the delivery result on success', async () => {
    const { POST } = await import('@/app/api/admin/portal/channels/webhook-deliveries/[id]/retry/route');
    const res = await POST(fakeRequest(), { params: { id: 'dlv_1' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, deliveryId: 'dlv_1', status: 'delivered' });
    expect(mockState.retryChannelWebhookDelivery).toHaveBeenCalledWith('dlv_1');
  });

  it('returns 200 with the failed result when the retry attempt itself fails again', async () => {
    mockState.retryChannelWebhookDelivery.mockResolvedValue({
      ok: false,
      deliveryId: 'dlv_1',
      status: 'failed',
      error: 'webhook_error:500:boom',
    });
    const { POST } = await import('@/app/api/admin/portal/channels/webhook-deliveries/[id]/retry/route');
    const res = await POST(fakeRequest(), { params: { id: 'dlv_1' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('failed');
  });
});
