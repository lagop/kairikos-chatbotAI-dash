// =============================================================================
// WP-XX — unit tests for the 30-day recording purge.
//
// This is where an RGPD promise is actually kept, so the property that
// matters most is the ORDERING: the audio must be gone at the provider
// BEFORE our own records claim it is. A test that only checked the local
// stamp would pass on an implementation that quietly lies.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { purgeExpiredRecordings, RECORDING_RETENTION_DAYS } from '@/lib/recall-retention';

const state = {
  findMany: vi.fn(),
  update: vi.fn(),
};

const prisma = {
  callEvent: {
    findMany: (...a: unknown[]) => state.findMany(...a),
    update: (...a: unknown[]) => state.update(...a),
  },
} as unknown as PrismaClient;

const AUTH = { accountSid: 'AC1', authToken: 'tok' };
const NOW = new Date('2026-10-01T12:00:00.000Z');
const originalFetch = globalThis.fetch;

beforeEach(() => {
  state.findMany.mockReset().mockResolvedValue([]);
  state.update.mockReset().mockResolvedValue({});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('purgeExpiredRecordings', () => {
  it('only looks at recordings past the retention window that are still present', async () => {
    await purgeExpiredRecordings(prisma, AUTH, { now: NOW });

    const where = state.findMany.mock.calls[0][0].where;
    expect(where.recordingSid).toEqual({ not: null });
    expect(where.recordingDeletedAt).toBeNull();
    const cutoff = where.startedAt.lt as Date;
    const expected = new Date(NOW.getTime() - RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    expect(cutoff.getTime()).toBe(expected.getTime());
  });

  it('takes the most overdue first and bounds the batch', async () => {
    await purgeExpiredRecordings(prisma, AUTH, { now: NOW, limit: 7 });
    const arg = state.findMany.mock.calls[0][0];
    expect(arg.orderBy).toEqual({ startedAt: 'asc' });
    expect(arg.take).toBe(7);
  });

  it('deletes at the provider BEFORE stamping locally', async () => {
    const order: string[] = [];
    state.findMany.mockResolvedValue([{ id: 'ce_1', recordingSid: 'RE1' }]);
    globalThis.fetch = vi.fn(async () => {
      order.push('twilio-delete');
      return { status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;
    state.update.mockImplementation(async () => {
      order.push('local-stamp');
      return {};
    });

    await purgeExpiredRecordings(prisma, AUTH, { now: NOW });

    // Reversed, this implementation would claim deletion while the audio
    // still sat on someone else's servers.
    expect(order).toEqual(['twilio-delete', 'local-stamp']);
  });

  it('sends an authenticated DELETE to the recording resource', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    state.findMany.mockResolvedValue([{ id: 'ce_1', recordingSid: 'RE1' }]);
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push([String(url), init]);
      return { status: 204 } as unknown as Response;
    }) as unknown as typeof fetch;

    await purgeExpiredRecordings(prisma, AUTH, { now: NOW });

    expect(calls[0][0]).toBe('https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1.json');
    expect(calls[0][1]?.method).toBe('DELETE');
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('AC1:tok').toString('base64')}`,
    );
  });

  it('clears the now-dead url alongside the stamp', async () => {
    state.findMany.mockResolvedValue([{ id: 'ce_1', recordingSid: 'RE1' }]);
    globalThis.fetch = vi.fn(async () => ({ status: 204 }) as unknown as Response) as unknown as typeof fetch;

    await purgeExpiredRecordings(prisma, AUTH, { now: NOW });

    const data = state.update.mock.calls[0][0].data;
    expect(data.recordingDeletedAt).toEqual(NOW);
    expect(data.recordingUrl).toBeNull();
    // The SID stays: it is the audit trail of what was deleted.
    expect(data.recordingSid).toBeUndefined();
  });

  it('treats an already-gone recording as done rather than retrying forever', async () => {
    state.findMany.mockResolvedValue([{ id: 'ce_1', recordingSid: 'RE1' }]);
    globalThis.fetch = vi.fn(async () => ({ status: 404 }) as unknown as Response) as unknown as typeof fetch;

    await expect(purgeExpiredRecordings(prisma, AUTH, { now: NOW })).resolves.toEqual({
      scanned: 1,
      purged: 1,
      failed: 0,
    });
    expect(state.update).toHaveBeenCalled();
  });

  it('NEVER stamps deleted when the provider rejected the delete', async () => {
    state.findMany.mockResolvedValue([{ id: 'ce_1', recordingSid: 'RE1' }]);
    globalThis.fetch = vi.fn(async () => ({ status: 500 }) as unknown as Response) as unknown as typeof fetch;

    await expect(purgeExpiredRecordings(prisma, AUTH, { now: NOW })).resolves.toEqual({
      scanned: 1,
      purged: 0,
      failed: 1,
    });
    // A false claim of deletion is the one outcome this must never produce.
    expect(state.update).not.toHaveBeenCalled();
  });

  it('treats a network throw as a failure, not a success', async () => {
    state.findMany.mockResolvedValue([{ id: 'ce_1', recordingSid: 'RE1' }]);
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await expect(purgeExpiredRecordings(prisma, AUTH, { now: NOW })).resolves.toEqual({
      scanned: 1,
      purged: 0,
      failed: 1,
    });
    expect(state.update).not.toHaveBeenCalled();
  });

  it('keeps going when one row fails', async () => {
    state.findMany.mockResolvedValue([
      { id: 'ce_1', recordingSid: 'RE1' },
      { id: 'ce_2', recordingSid: 'RE2' },
    ]);
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return { status: n === 1 ? 500 : 204 } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(purgeExpiredRecordings(prisma, AUTH, { now: NOW })).resolves.toEqual({
      scanned: 2,
      purged: 1,
      failed: 1,
    });
  });

  it('counts a local stamp failure as failed so the next sweep retries it', async () => {
    state.findMany.mockResolvedValue([{ id: 'ce_1', recordingSid: 'RE1' }]);
    globalThis.fetch = vi.fn(async () => ({ status: 204 }) as unknown as Response) as unknown as typeof fetch;
    state.update.mockRejectedValue(new Error('db down'));

    await expect(purgeExpiredRecordings(prisma, AUTH, { now: NOW })).resolves.toEqual({
      scanned: 1,
      purged: 0,
      failed: 1,
    });
  });
});
