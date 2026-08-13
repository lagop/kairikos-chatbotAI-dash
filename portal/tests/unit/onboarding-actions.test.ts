// =============================================================================
// KAIA-1062 — unit tests for src/lib/onboarding-actions.ts
//
// Pure validation tests: the row-isolation rule, snooze cap, milestone
// allowlist, and the dedup contract. The handlers themselves exercise
// Prisma; the Playwright smoke (tests/specs/client-self-service.spec.ts)
// covers the route + UI layer.
// =============================================================================

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

// Hoisted state for the mocked Prisma module.
const mockState = vi.hoisted(() => ({
  findUniqueActivity: vi.fn(),
  findManyActivity: vi.fn(),
  updateActivity: vi.fn(),
  upsertActivity: vi.fn(),
  findUniqueClient: vi.fn(),
  updateClient: vi.fn(),
  findFirstClientProduct: vi.fn(),
  updateClientProduct: vi.fn(),
  findUniqueOperatorNotification: vi.fn(),
  upsertOperatorNotification: vi.fn(),
  isDatabaseConfigured: true,
  sendOperatorNotification: vi.fn(),
  resolveOperatorRecipients: vi.fn(() => [{ email: 'ops@example.com' }]),
  utcDayKey: () => '2026-06-12',
}));

// WP-14 — handleGoLiveReady's state write now runs inside a
// prisma.$transaction (to commit atomically with the ClientProduct mirror
// write), so the mock's $transaction just invokes the callback with a `tx`
// exposing the same chatbotClient.update + a clientProduct table.
const mockTx = {
  chatbotClient: {
    update: (...args: unknown[]) => mockState.updateClient(...(args as [])),
  },
  clientProduct: {
    findFirst: (...args: unknown[]) =>
      mockState.findFirstClientProduct(...(args as [])),
    update: (...args: unknown[]) =>
      mockState.updateClientProduct(...(args as [])),
  },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
    chatbotActivity: {
      findUnique: (...args: unknown[]) =>
        mockState.findUniqueActivity(...(args as [])),
      findMany: (...args: unknown[]) =>
        mockState.findManyActivity(...(args as [])),
      update: (...args: unknown[]) =>
        mockState.updateActivity(...(args as [])),
      upsert: (...args: unknown[]) =>
        mockState.upsertActivity(...(args as [])),
    },
    chatbotClient: {
      findUnique: (...args: unknown[]) =>
        mockState.findUniqueClient(...(args as [])),
      update: (...args: unknown[]) =>
        mockState.updateClient(...(args as [])),
    },
    operatorNotification: {
      findUnique: (...args: unknown[]) =>
        mockState.findUniqueOperatorNotification(...(args as [])),
      upsert: (...args: unknown[]) =>
        mockState.upsertOperatorNotification(...(args as [])),
    },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/operator-notify', () => ({
  resolveOperatorRecipients: mockState.resolveOperatorRecipients,
  sendOperatorNotification: mockState.sendOperatorNotification,
  utcDayKey: mockState.utcDayKey,
}));

import { handleSnooze, handleGoLiveReady, handleAssetsUploaded } from '@/lib/onboarding-actions';

beforeEach(() => {
  Object.values(mockState).forEach((fn) => {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as { mockReset: () => void }).mockReset();
  });
  mockState.isDatabaseConfigured = true;
  mockState.resolveOperatorRecipients.mockReturnValue([{ email: 'ops@example.com' }]);
  mockState.utcDayKey = () => '2026-06-12';
  mockState.sendOperatorNotification.mockResolvedValue({
    ok: true,
    messageId: 'msg_1',
  });
  process.env.KAIRIKOS_OPERATOR_EMAILS = 'ops@example.com';
  process.env.NEXT_PUBLIC_PORTAL_URL = 'https://portal.kairikos.com';
});

afterEach(() => {
  delete process.env.KAIRIKOS_OPERATOR_EMAILS;
  delete process.env.NEXT_PUBLIC_PORTAL_URL;
});

async function bodyOf(res: NextResponse): Promise<{ status: number; body: any }> {
  const status = res.status;
  const clone = res.clone();
  const body = await clone.json();
  return { status, body };
}

describe('handleSnooze', () => {
  it('rejects an unknown milestone with 400', async () => {
    const res = await handleSnooze('client-1', { milestoneId: 'T+99', days: 1 });
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('bad_request');
  });

  it('caps days at 1 even if the caller asks for more', async () => {
    const baseDate = new Date('2026-06-10T10:00:00.000Z');
    mockState.findUniqueActivity.mockResolvedValue({
      id: 'a1',
      completedAt: baseDate,
      notes: null,
    });
    mockState.updateActivity.mockResolvedValue({
      id: 'a1',
      milestone: 'T+3',
      completedAt: new Date('2026-06-09T10:00:00.000Z'),
      notes: 'Snooze +1d desde portal (2026-06-12T00:00:00.000Z)',
    });
    const res = await handleSnooze('client-1', { milestoneId: 'T+3', days: 365 });
    const { status, body } = await bodyOf(res);
    expect(status).toBe(200);
    expect(body.activity.completedAt).toBe(new Date('2026-06-09T10:00:00.000Z').toISOString());
    expect(mockState.updateActivity).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the milestone is not owned by the client (row isolation)', async () => {
    mockState.findUniqueActivity.mockResolvedValue(null);
    const res = await handleSnooze('client-1', { milestoneId: 'T+3', days: 1 });
    const { status, body } = await bodyOf(res);
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
    expect(mockState.updateActivity).not.toHaveBeenCalled();
  });
});

describe('handleGoLiveReady', () => {
  it('refuses when the client is already live', async () => {
    mockState.findUniqueClient.mockResolvedValue({
      id: 'c1',
      name: 'Acme',
      companyName: 'Acme',
      state: 'live',
      goLiveAt: new Date(),
    });
    const res = await handleGoLiveReady('c1', {});
    const { status, body } = await bodyOf(res);
    expect(status).toBe(409);
    expect(body.error).toBe('conflict');
  });

  it('refuses when prior milestones are incomplete', async () => {
    mockState.findUniqueClient.mockResolvedValue({
      id: 'c1',
      name: 'Acme',
      companyName: 'Acme',
      state: 'in-progress',
      goLiveAt: null,
    });
    // Only T+0 and T+3 are done; T+7 is missing.
    mockState.findManyActivity.mockResolvedValue([
      { milestone: 'T+0', completedAt: new Date() },
      { milestone: 'T+3', completedAt: new Date() },
    ]);
    const res = await handleGoLiveReady('c1', {});
    const { status, body } = await bodyOf(res);
    expect(status).toBe(409);
    expect(body.detail).toContain('T+7');
    expect(mockState.updateClient).not.toHaveBeenCalled();
  });

  it('flips state to go-live-pending and emails the operator when eligible', async () => {
    mockState.findUniqueClient.mockResolvedValue({
      id: 'c1',
      name: 'Acme',
      companyName: 'Acme',
      state: 'in-progress',
      goLiveAt: null,
      tenantId: 'tenant-1',
    });
    mockState.findManyActivity.mockResolvedValue([
      { milestone: 'T+0', completedAt: new Date() },
      { milestone: 'T+3', completedAt: new Date() },
      { milestone: 'T+7', completedAt: new Date() },
    ]);
    mockState.updateClient.mockResolvedValue({ id: 'c1', state: 'go-live-pending' });
    mockState.findUniqueOperatorNotification.mockResolvedValue(null);
    mockState.upsertOperatorNotification.mockResolvedValue({ id: 'n1' });
    const res = await handleGoLiveReady('c1', {});
    const { status, body } = await bodyOf(res);
    expect(status).toBe(200);
    expect(body.state).toBe('go-live-pending');
    expect(body.deduped).toBe(false);
    expect(body.notify.sent).toBe(true);
    expect(mockState.sendOperatorNotification).toHaveBeenCalledTimes(1);
    // WP-09 — the notification dedup row denormalizes tenantId from the client.
    expect(mockState.upsertOperatorNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ clientId: 'c1', tenantId: 'tenant-1' }),
      }),
    );
  });

  it('dedupes a repeat click within the same UTC day', async () => {
    mockState.findUniqueClient.mockResolvedValue({
      id: 'c1',
      name: 'Acme',
      companyName: 'Acme',
      state: 'in-progress',
      goLiveAt: null,
    });
    mockState.findManyActivity.mockResolvedValue([
      { milestone: 'T+0', completedAt: new Date() },
      { milestone: 'T+3', completedAt: new Date() },
      { milestone: 'T+7', completedAt: new Date() },
    ]);
    mockState.updateClient.mockResolvedValue({ id: 'c1', state: 'go-live-pending' });
    mockState.findUniqueOperatorNotification.mockResolvedValue({
      id: 'n1',
      sentAt: new Date(),
      resendMessageId: 'msg_1',
    });
    const res = await handleGoLiveReady('c1', {});
    const { status, body } = await bodyOf(res);
    expect(status).toBe(200);
    expect(body.deduped).toBe(true);
    expect(mockState.sendOperatorNotification).not.toHaveBeenCalled();
  });

  it('returns a deduped response when the client is already in go-live-pending', async () => {
    mockState.findUniqueClient.mockResolvedValue({
      id: 'c1',
      name: 'Acme',
      companyName: 'Acme',
      state: 'go-live-pending',
      goLiveAt: null,
    });
    const res = await handleGoLiveReady('c1', {});
    const { status, body } = await bodyOf(res);
    expect(status).toBe(200);
    expect(body.deduped).toBe(true);
    expect(body.state).toBe('go-live-pending');
  });
});

describe('handleAssetsUploaded', () => {
  it('stamps tenantId from the client onto the created activity row (WP-09)', async () => {
    mockState.findUniqueActivity.mockResolvedValueOnce(null);
    mockState.findUniqueClient.mockResolvedValueOnce({ tenantId: 'tenant-1' });
    mockState.upsertActivity.mockResolvedValueOnce({
      id: 'a3',
      milestone: 'T+3',
      completedAt: new Date('2026-06-12T00:00:00.000Z'),
      notes: 'Marcado por el cliente desde el portal.',
    });

    await handleAssetsUploaded('c1', {});

    expect(mockState.upsertActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ clientId: 'c1', tenantId: 'tenant-1' }),
      }),
    );
  });

  it('falls back to a null tenantId when the client lookup finds nothing', async () => {
    mockState.findUniqueActivity.mockResolvedValueOnce(null);
    mockState.findUniqueClient.mockResolvedValueOnce(null);
    mockState.upsertActivity.mockResolvedValueOnce({
      id: 'a3',
      milestone: 'T+3',
      completedAt: new Date('2026-06-12T00:00:00.000Z'),
      notes: 'Marcado por el cliente desde el portal.',
    });

    await handleAssetsUploaded('c1', {});

    expect(mockState.upsertActivity).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ tenantId: null }) }),
    );
  });

  it('is idempotent — second call returns deduped:true', async () => {
    mockState.findUniqueActivity.mockResolvedValueOnce({
      id: 'a3',
      completedAt: null,
      notes: null,
    });
    mockState.findUniqueClient.mockResolvedValue({ tenantId: 'tenant-1' });
    mockState.upsertActivity.mockResolvedValueOnce({
      id: 'a3',
      milestone: 'T+3',
      completedAt: new Date('2026-06-12T00:00:00.000Z'),
      notes: 'Marcado por el cliente desde el portal.',
    });
    const first = await handleAssetsUploaded('c1', {});
    const { status: s1, body: b1 } = await bodyOf(first);
    expect(s1).toBe(200);
    expect(b1.deduped).toBe(false);

    // Second call: row already has completedAt, so the upsert update
    // branch is the no-stamp branch and the response is deduped.
    mockState.findUniqueActivity.mockResolvedValueOnce({
      id: 'a3',
      completedAt: new Date('2026-06-12T00:00:00.000Z'),
      notes: 'Marcado por el cliente desde el portal.',
    });
    mockState.upsertActivity.mockResolvedValueOnce({
      id: 'a3',
      milestone: 'T+3',
      completedAt: new Date('2026-06-12T00:00:00.000Z'),
      notes: 'Marcado por el cliente desde el portal.',
    });
    const second = await handleAssetsUploaded('c1', {});
    const { status: s2, body: b2 } = await bodyOf(second);
    expect(s2).toBe(200);
    expect(b2.deduped).toBe(true);
  });
});
