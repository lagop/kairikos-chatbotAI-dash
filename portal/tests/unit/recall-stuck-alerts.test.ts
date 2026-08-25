// =============================================================================
// WP-XX — unit tests for stuck-onboarding alerts.
//
// The property that matters: a client stalled for nine days must produce
// at most one email per day, not one per scheduler tick — and a FAILED
// send must not consume that day's slot, or the operator would never hear
// about the client at all.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  listRecallQueue: vi.fn(),
  sendOperatorNotification: vi.fn(),
  resolveOperatorRecipients: vi.fn(),
}));

vi.mock('@/lib/recall', async () => {
  const actual = await vi.importActual<typeof import('@/lib/recall')>('@/lib/recall');
  return { ...actual, listRecallQueue: (...a: unknown[]) => mockState.listRecallQueue(...a) };
});

vi.mock('@/lib/operator-notify', async () => {
  const actual = await vi.importActual<typeof import('@/lib/operator-notify')>('@/lib/operator-notify');
  return {
    ...actual,
    sendOperatorNotification: (...a: unknown[]) => mockState.sendOperatorNotification(...a),
    resolveOperatorRecipients: (...a: unknown[]) => mockState.resolveOperatorRecipients(...a),
  };
});

const state = {
  notificationFindUnique: vi.fn(),
  notificationCreate: vi.fn(),
};

const prisma = {
  operatorNotification: {
    findUnique: (...a: unknown[]) => state.notificationFindUnique(...a),
    create: (...a: unknown[]) => state.notificationCreate(...a),
  },
} as unknown as PrismaClient;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

function queueRow(overrides: Record<string, unknown> = {}) {
  return {
    subscriptionId: 'sub_1',
    clientId: 'client_1',
    clientName: 'Fontanería Aurora',
    clientEmail: 'a@b.com',
    // forwarding_pending has a 1-day threshold, so 9 days is stuck.
    status: 'forwarding_pending',
    since: daysAgo(9),
    e164: '+34910000001',
    hasGreeting: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockState.listRecallQueue.mockReset().mockResolvedValue([]);
  mockState.resolveOperatorRecipients.mockReset().mockReturnValue([{ email: 'ops@kairikos.com' }]);
  mockState.sendOperatorNotification.mockReset().mockResolvedValue({ ok: true, messageId: 'msg_1' });
  state.notificationFindUnique.mockReset().mockResolvedValue(null);
  state.notificationCreate.mockReset().mockResolvedValue({});
});

async function run() {
  const { notifyStuckOnboardings } = await import('@/lib/recall-stuck-alerts');
  return notifyStuckOnboardings(prisma, { now: NOW });
}

describe('notifyStuckOnboardings', () => {
  it('notifies a stalled alta and records it', async () => {
    mockState.listRecallQueue.mockResolvedValue([queueRow()]);

    await expect(run()).resolves.toEqual({ scanned: 1, stuck: 1, notified: 1, deduped: 0, failed: 0 });
    expect(mockState.sendOperatorNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stuck', to: [{ email: 'ops@kairikos.com' }] }),
    );
    expect(state.notificationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ clientId: 'client_1', kind: 'stuck', day: '2026-10-01' }),
    });
  });

  it('ignores an alta that has not passed its own threshold', async () => {
    // templates_approved gets 4 days; this one is 1 day old.
    mockState.listRecallQueue.mockResolvedValue([
      queueRow({ status: 'templates_approved', since: daysAgo(1) }),
    ]);

    await expect(run()).resolves.toEqual({ scanned: 1, stuck: 0, notified: 0, deduped: 0, failed: 0 });
    expect(mockState.sendOperatorNotification).not.toHaveBeenCalled();
  });

  it('sends at most one mail per client per day, however often the tick runs', async () => {
    mockState.listRecallQueue.mockResolvedValue([queueRow()]);
    state.notificationFindUnique.mockResolvedValue({ id: 'notif_1' });

    await expect(run()).resolves.toEqual({ scanned: 1, stuck: 1, notified: 0, deduped: 1, failed: 0 });
    expect(mockState.sendOperatorNotification).not.toHaveBeenCalled();
  });

  it('does NOT consume the day slot when the send fails — tomorrow must retry', async () => {
    mockState.listRecallQueue.mockResolvedValue([queueRow()]);
    mockState.sendOperatorNotification.mockResolvedValue({ ok: false, error: 'resend_down' });

    await expect(run()).resolves.toEqual({ scanned: 1, stuck: 1, notified: 0, deduped: 0, failed: 1 });
    // Writing the dedup row here would silence this client permanently.
    expect(state.notificationCreate).not.toHaveBeenCalled();
  });

  it('still reports the stuck count when no operator recipients are configured', async () => {
    mockState.listRecallQueue.mockResolvedValue([queueRow()]);
    mockState.resolveOperatorRecipients.mockReturnValue([]);

    // The count is useful telemetry on its own, and returning a silent
    // zero would hide the misconfiguration.
    await expect(run()).resolves.toEqual({ scanned: 1, stuck: 1, notified: 0, deduped: 0, failed: 0 });
    expect(mockState.sendOperatorNotification).not.toHaveBeenCalled();
  });

  it('names the parked state and its threshold in the alert', async () => {
    mockState.listRecallQueue.mockResolvedValue([queueRow()]);
    await run();

    const subject = mockState.sendOperatorNotification.mock.calls[0][0].subject as string;
    expect(subject).toContain('forwarding_pending');
    expect(subject).toContain('umbral 1d');
  });

  it('keeps going when one client throws', async () => {
    mockState.listRecallQueue.mockResolvedValue([
      queueRow(),
      queueRow({ subscriptionId: 'sub_2', clientId: 'client_2' }),
    ]);
    state.notificationFindUnique
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce(null);

    await expect(run()).resolves.toEqual({ scanned: 2, stuck: 2, notified: 1, deduped: 0, failed: 1 });
  });
});
