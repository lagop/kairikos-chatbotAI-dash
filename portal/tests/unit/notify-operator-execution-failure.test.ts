// =============================================================================
// WP-26 — unit tests for notifyOperatorOfExecutionFailure() in
// operator-notify.ts. This is the in-process alert path (as opposed to
// the HTTP-facing POST /api/internal/notify-operator, which already has
// its own contract covered by scripts/smoke-notify-operator.ts).
//
// RESEND_API_KEY is intentionally left unset — sendOperatorNotification()
// already has a documented dev-mode path for that (skipped, no_api_key)
// that doesn't touch the Resend SDK, so these tests exercise the real
// dedup + persistence logic without mocking Resend.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    operatorNotification: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      upsert: (...args: unknown[]) => upsert(...args),
    },
  },
}));

import { notifyOperatorOfExecutionFailure } from '@/lib/operator-notify';

const BASE_CTX = {
  executionId: 'exec_123',
  workflowName: 'stripe_webhook:invoice.payment_failed',
  error: 'boom',
};

describe('notifyOperatorOfExecutionFailure', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
    process.env.KAIRIKOS_OPERATOR_EMAILS = 'ops@kairikos.com';
    delete process.env.KAIRIKOS_NOTIFY_KINDS;
    delete process.env.RESEND_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('skips (no DB touched) when KAIRIKOS_OPERATOR_EMAILS is unset', async () => {
    delete process.env.KAIRIKOS_OPERATOR_EMAILS;
    const result = await notifyOperatorOfExecutionFailure(BASE_CTX);
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_recipients' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('skips when KAIRIKOS_NOTIFY_KINDS opts out of execution-failed', async () => {
    process.env.KAIRIKOS_NOTIFY_KINDS = 'stuck,escalation';
    const result = await notifyOperatorOfExecutionFailure(BASE_CTX);
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'kind_disabled' });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('dedupes: an existing row for (clientId, kind, day) short-circuits without sending', async () => {
    findUnique.mockResolvedValueOnce({ id: 'notif_1' });
    const result = await notifyOperatorOfExecutionFailure({ ...BASE_CTX, clientId: 'client_1' });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'deduped' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('uses the __unassigned__ sentinel for the dedup key when clientId is absent', async () => {
    findUnique.mockResolvedValueOnce(null);
    await notifyOperatorOfExecutionFailure(BASE_CTX);
    const arg = findUnique.mock.calls[0][0] as { where: { clientId_kind_day: { clientId: string } } };
    expect(arg.where.clientId_kind_day.clientId).toBe('__unassigned__');
  });

  it('sends (dev no-op path) and persists a row when no prior notification exists', async () => {
    findUnique.mockResolvedValueOnce(null);
    upsert.mockResolvedValueOnce({ id: 'notif_new' });
    const result = await notifyOperatorOfExecutionFailure({ ...BASE_CTX, clientId: 'client_1' });
    // No RESEND_API_KEY in this test env — sendOperatorNotification's
    // documented dev path returns skipped/no_api_key, not an error.
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_api_key' });
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0] as { where: { clientId_kind_day: { clientId: string; kind: string } } };
    expect(arg.where.clientId_kind_day).toMatchObject({ clientId: 'client_1', kind: 'execution-failed' });
  });
});
