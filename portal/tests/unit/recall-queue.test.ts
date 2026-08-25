// =============================================================================
// WP-XX — unit tests for listRecallQueue (the operator's stuck-onboarding
// inbox).
//
// The subtle part under test is WHICH CLOCK the stuck badge reads. Each
// transition seals its own timestamp, and the queue must date a row by
// the stamp of the transition that put it in its current state — never by
// `updatedAt`, which any unrelated edit resets and would thereby hide a
// client who has been stalled for a week.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { listRecallQueue } from '@/lib/recall';

const findMany = vi.fn();
const prisma = { recallSubscription: { findMany: (...a: unknown[]) => findMany(...a) } } as unknown as PrismaClient;

const CREATED = new Date('2026-09-01T09:00:00.000Z');
const SIGNED = new Date('2026-09-03T09:00:00.000Z');
const META = new Date('2026-09-05T09:00:00.000Z');
const TEMPLATES = new Date('2026-09-07T09:00:00.000Z');
const VERIFIED = new Date('2026-09-08T09:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    clientId: 'client_1',
    status: 'paid',
    updatedAt: new Date('2026-09-20T09:00:00.000Z'),
    createdAt: CREATED,
    contractSignedAt: null,
    metaConnectedAt: null,
    numberAssignedAt: null,
    templatesApprovedAt: null,
    forwardingVerifiedAt: null,
    greetingRecordedAt: null,
    client: { name: 'Juan', companyName: 'Fontanería Aurora', email: 'a@b.com' },
    virtualNumber: null,
    ...overrides,
  };
}

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
});

describe('listRecallQueue', () => {
  it('asks for onboarding states only, never active/paused/cancelled', async () => {
    await listRecallQueue(prisma);
    const where = findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual([
      'paid',
      'contract_signed',
      'meta_connected',
      'number_assigned',
      'templates_approved',
      'forwarding_pending',
      'forwarding_verified',
    ]);
    expect(where.status.in).not.toContain('active');
  });

  it('is a SINGLE query — no per-client loop', async () => {
    findMany.mockResolvedValue([row(), row({ id: 'sub_2', clientId: 'client_2' })]);
    await listRecallQueue(prisma);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('does not pull the greeting audio down, only whether one exists', async () => {
    await listRecallQueue(prisma);
    const select = findMany.mock.calls[0][0].select;
    // BYTEA of a couple hundred KB per row; the queue only needs presence.
    expect(select.greetingAudio).toBeUndefined();
    expect(select.greetingRecordedAt).toBe(true);
  });

  it('prefers the company name and falls back to the contact name', async () => {
    findMany.mockResolvedValue([
      row(),
      row({ id: 'sub_2', client: { name: 'Juan', companyName: null, email: 'a@b.com' } }),
    ]);
    const rows = await listRecallQueue(prisma);
    expect(rows[0].clientName).toBe('Fontanería Aurora');
    expect(rows[1].clientName).toBe('Juan');
  });

  it('surfaces the assigned number and greeting state', async () => {
    findMany.mockResolvedValue([
      row({ virtualNumber: { e164: '+34910000001' }, greetingRecordedAt: META }),
    ]);
    const [r] = await listRecallQueue(prisma);
    expect(r.e164).toBe('+34910000001');
    expect(r.hasGreeting).toBe(true);
  });

  it.each([
    ['paid', {}, CREATED],
    ['contract_signed', { contractSignedAt: SIGNED }, SIGNED],
    ['meta_connected', { metaConnectedAt: META }, META],
    ['templates_approved', { templatesApprovedAt: TEMPLATES }, TEMPLATES],
    // forwarding_pending is entered by the same act that approved the
    // templates — no separate stamp exists, and adding one would record
    // the same instant twice.
    ['forwarding_pending', { templatesApprovedAt: TEMPLATES }, TEMPLATES],
    ['forwarding_verified', { forwardingVerifiedAt: VERIFIED }, VERIFIED],
  ])('dates a %s row by the transition that put it there', async (status, stamps, expected) => {
    findMany.mockResolvedValue([row({ status, ...stamps })]);
    const [r] = await listRecallQueue(prisma);
    expect(r.since).toEqual(expected);
  });

  it('never dates a row by updatedAt — an unrelated edit must not hide a stall', async () => {
    const staleSince = new Date('2026-09-02T09:00:00.000Z');
    findMany.mockResolvedValue([
      row({
        status: 'forwarding_pending',
        templatesApprovedAt: staleSince,
        // Something touched the row today for an unrelated reason.
        updatedAt: new Date('2026-09-20T09:00:00.000Z'),
      }),
    ]);
    const [r] = await listRecallQueue(prisma);
    expect(r.since).toEqual(staleSince);
  });

  it('falls back to createdAt when the expected stamp is somehow missing', async () => {
    // Defensive: a row edited by hand, or an older row from before a
    // stamp existed, must still produce a usable clock rather than crash
    // or report "stuck since the epoch".
    findMany.mockResolvedValue([row({ status: 'meta_connected', metaConnectedAt: null })]);
    const [r] = await listRecallQueue(prisma);
    expect(r.since).toEqual(CREATED);
  });
});
