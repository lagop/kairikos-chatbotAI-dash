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
const templateDefinitionCount = vi.fn();
const whatsappTemplateFindMany = vi.fn();
const prisma = {
  recallSubscription: { findMany: (...a: unknown[]) => findMany(...a) },
  recallTemplateDefinition: { count: (...a: unknown[]) => templateDefinitionCount(...a) },
  whatsappTemplate: { findMany: (...a: unknown[]) => whatsappTemplateFindMany(...a) },
} as unknown as PrismaClient;

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
    metaConnectionId: null,
    client: { name: 'Juan', companyName: 'Fontanería Aurora', email: 'a@b.com' },
    virtualNumber: null,
    ...overrides,
  };
}

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
  templateDefinitionCount.mockReset().mockResolvedValue(7);
  whatsappTemplateFindMany.mockReset().mockResolvedValue([]);
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

  describe('templateProgress', () => {
    it('is null when the row has no WhatsApp connection yet', async () => {
      findMany.mockResolvedValue([row({ metaConnectionId: null })]);
      const [r] = await listRecallQueue(prisma);
      expect(r.templateProgress).toBeNull();
      expect(whatsappTemplateFindMany).not.toHaveBeenCalled();
    });

    it('resolves 0/total with no rejections when a connection exists but nothing has synced yet', async () => {
      findMany.mockResolvedValue([row({ metaConnectionId: 'conn_1' })]);
      const [r] = await listRecallQueue(prisma);
      expect(r.templateProgress).toEqual({ approved: 0, total: 7, rejected: [] });
    });

    it('counts APPROVED and collects REJECTED with its reason, ignoring PENDING', async () => {
      findMany.mockResolvedValue([row({ metaConnectionId: 'conn_1' })]);
      whatsappTemplateFindMany.mockResolvedValue([
        { connectionId: 'conn_1', name: 'recall_caller_open', status: 'APPROVED', rejectedReason: null },
        { connectionId: 'conn_1', name: 'recall_caller_closed', status: 'APPROVED', rejectedReason: null },
        { connectionId: 'conn_1', name: 'recall_owner_message', status: 'PENDING', rejectedReason: null },
        { connectionId: 'conn_1', name: 'recall_daily_digest', status: 'REJECTED', rejectedReason: 'texto genérico' },
      ]);
      const [r] = await listRecallQueue(prisma);
      expect(r.templateProgress).toEqual({
        approved: 2,
        total: 7,
        rejected: [{ name: 'recall_daily_digest', reason: 'texto genérico' }],
      });
    });

    it('is ONE batched query for every row with a connection, not one per row', async () => {
      findMany.mockResolvedValue([
        row({ id: 'sub_1', metaConnectionId: 'conn_1' }),
        row({ id: 'sub_2', clientId: 'client_2', metaConnectionId: 'conn_2' }),
      ]);
      await listRecallQueue(prisma);
      expect(whatsappTemplateFindMany).toHaveBeenCalledTimes(1);
      expect(whatsappTemplateFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { connectionId: { in: ['conn_1', 'conn_2'] } } }),
      );
    });

    it('keeps each connection independent — one connection is unaffected by another connection in the same batch', async () => {
      findMany.mockResolvedValue([
        row({ id: 'sub_1', metaConnectionId: 'conn_1' }),
        row({ id: 'sub_2', clientId: 'client_2', metaConnectionId: 'conn_2' }),
      ]);
      whatsappTemplateFindMany.mockResolvedValue([
        { connectionId: 'conn_1', name: 'recall_caller_open', status: 'APPROVED', rejectedReason: null },
      ]);
      const [r1, r2] = await listRecallQueue(prisma);
      expect(r1.templateProgress).toEqual({ approved: 1, total: 7, rejected: [] });
      expect(r2.templateProgress).toEqual({ approved: 0, total: 7, rejected: [] });
    });
  });
});
