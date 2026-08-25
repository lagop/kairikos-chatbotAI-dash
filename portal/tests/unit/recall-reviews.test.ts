// =============================================================================
// WP-XX (Fase 10) — unit tests for the review half's orchestration.
//
// The properties that matter are all about NOT doing something twice and
// NOT doing something the owner did not ask for: one digest per day
// however often the tick runs, one clarification ever, one reminder ever,
// and review invitations only to the people he actually named.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  sendTemplate: vi.fn(),
  metaSenderFor: vi.fn(),
  createCampaignWithRequests: vi.fn(),
  dispatchReviewRequest: vi.fn(),
}));

vi.mock('@/lib/whatsapp-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/whatsapp-api')>('@/lib/whatsapp-api');
  return { ...actual, sendTemplate: (...a: unknown[]) => mockState.sendTemplate(...a) };
});
vi.mock('@/lib/recall-messaging', () => ({
  metaSenderFor: (...a: unknown[]) => mockState.metaSenderFor(...a),
}));
vi.mock('@/lib/review-request-campaign', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/review-request-campaign')>('@/lib/review-request-campaign');
  return {
    ...actual,
    createCampaignWithRequests: (...a: unknown[]) => mockState.createCampaignWithRequests(...a),
    dispatchReviewRequest: (...a: unknown[]) => mockState.dispatchReviewRequest(...a),
  };
});

import {
  sendDailyDigests,
  applyDigestReply,
  sweepReviewReminders,
  REVIEW_REMINDER_DAYS,
} from '@/lib/recall-reviews';
import { MAX_DIGEST_ATTEMPTS, DIGEST_REPLY_WINDOW_HOURS } from '@/lib/recall-digest';

const state = {
  subFindMany: vi.fn(),
  subFindUnique: vi.fn(),
  subFindFirst: vi.fn(),
  digestFindUnique: vi.fn(),
  digestFindFirst: vi.fn(),
  digestCreate: vi.fn(),
  digestUpdate: vi.fn(),
  callFindMany: vi.fn(),
  reviewFindMany: vi.fn(),
  reviewUpdate: vi.fn(),
  connectionFindFirst: vi.fn(),
};

const prisma = {
  recallSubscription: {
    findMany: (...a: unknown[]) => state.subFindMany(...a),
    findUnique: (...a: unknown[]) => state.subFindUnique(...a),
    findFirst: (...a: unknown[]) => state.subFindFirst(...a),
  },
  recallDigest: {
    findUnique: (...a: unknown[]) => state.digestFindUnique(...a),
    findFirst: (...a: unknown[]) => state.digestFindFirst(...a),
    create: (...a: unknown[]) => state.digestCreate(...a),
    update: (...a: unknown[]) => state.digestUpdate(...a),
  },
  callEvent: { findMany: (...a: unknown[]) => state.callFindMany(...a) },
  reviewRequest: {
    findMany: (...a: unknown[]) => state.reviewFindMany(...a),
    update: (...a: unknown[]) => state.reviewUpdate(...a),
  },
  metaChannelConnection: { findFirst: (...a: unknown[]) => state.connectionFindFirst(...a) },
} as unknown as PrismaClient;

// 19:10 in Madrid on a Tuesday.
const NOW = new Date('2026-07-07T17:10:00.000Z');
const CONNECTION = {
  id: 'conn_1',
  externalId: 'phone_1',
  status: 'active',
  accessTokenCiphertext: Buffer.from('c'),
  accessTokenIv: Buffer.from('i'),
  accessTokenTag: Buffer.from('t'),
};

function subscription(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    clientId: 'client_1',
    digestHour: 19,
    timezone: 'Europe/Madrid',
    ownerWhatsapp: '+34600111222',
    metaConnection: CONNECTION,
    ...over,
  };
}

function call(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    fromNumber: `+3465100000${id.slice(-1)}`,
    withheld: false,
    transcript: 'Llamaba por una fuga',
    outcome: 'recorded',
    ...over,
  };
}

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  mockState.sendTemplate.mockReset().mockResolvedValue({ ok: true, data: { messages: [{ id: 'wamid.1' }] } });
  mockState.metaSenderFor.mockReset().mockReturnValue({ token: 'tok', phoneNumberId: 'phone_1' });
  mockState.createCampaignWithRequests
    .mockReset()
    .mockResolvedValue({ ok: true, campaignId: 'camp_1', sent: 1, failed: 0, skipped: 0 });
  mockState.dispatchReviewRequest.mockReset().mockResolvedValue({ ok: true, messageId: 'wamid.r' });

  state.subFindMany.mockResolvedValue([]);
  state.digestFindUnique.mockResolvedValue(null);
  state.digestFindFirst.mockResolvedValue(null);
  state.digestCreate.mockResolvedValue({ id: 'dig_1' });
  state.digestUpdate.mockResolvedValue({});
  state.callFindMany.mockResolvedValue([]);
  state.reviewFindMany.mockResolvedValue([]);
  state.reviewUpdate.mockResolvedValue({});
  state.connectionFindFirst.mockResolvedValue(CONNECTION);
});

describe('sendDailyDigests', () => {
  it('sends one numbered summary and stamps it', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue([call('c1'), call('c2')]);

    await expect(sendDailyDigests(prisma, { now: NOW })).resolves.toMatchObject({ scanned: 1, sent: 1 });

    const [, , to, template] = mockState.sendTemplate.mock.calls[0];
    expect(to).toBe('+34600111222');
    expect(template.bodyParams[0]).toBe('2');
    expect(template.bodyParams[1]).toContain('1)');
    expect(template.bodyParams[1]).toContain('2)');
    expect(state.digestUpdate.mock.calls[0][0].data.sentAt).toBe(NOW);
  });

  it('records the call ORDER, because the owner replies by position', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue([call('c1'), call('c2')]);
    await sendDailyDigests(prisma, { now: NOW });
    expect(state.digestCreate.mock.calls[0][0].data.callEventIds).toEqual(['c1', 'c2']);
  });

  it('does not send twice, however often the tick runs', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.digestFindUnique.mockResolvedValue({
      id: 'dig_1',
      sentAt: new Date('2026-07-07T17:05:00.000Z'),
      attempts: 0,
      callEventIds: ['c1'],
    });

    await sendDailyDigests(prisma, { now: NOW });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('stays silent on a day with nothing to report', async () => {
    // An empty "no has perdido ninguna llamada hoy" every evening is how
    // a client learns to ignore the number we need him to read.
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue([]);

    await expect(sendDailyDigests(prisma, { now: NOW })).resolves.toMatchObject({ skippedNoCalls: 1, sent: 0 });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
    expect(state.digestCreate).not.toHaveBeenCalled();
  });

  it('skips a client whose local clock has not reached his digest hour', async () => {
    // Same instant, a zone five hours earlier: it is still afternoon there.
    state.subFindMany.mockResolvedValue([subscription({ timezone: 'America/New_York' })]);
    await expect(sendDailyDigests(prisma, { now: NOW })).resolves.toMatchObject({ scanned: 0, sent: 0 });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('counts a failed send and leaves the row unsent for the next tick', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue([call('c1')]);
    mockState.sendTemplate.mockResolvedValue({ ok: false, error: 'rate limited', code: 131056 });

    await expect(sendDailyDigests(prisma, { now: NOW })).resolves.toMatchObject({ failed: 1, sent: 0 });
    const data = state.digestUpdate.mock.calls[0][0].data;
    expect(data.sentAt).toBeUndefined();
    expect(data.attempts).toEqual({ increment: 1 });
  });

  it('stops retrying a digest that has already failed its budget', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.digestFindUnique.mockResolvedValue({
      id: 'dig_1',
      sentAt: null,
      attempts: MAX_DIGEST_ATTEMPTS,
      callEventIds: ['c1'],
    });

    await sendDailyDigests(prisma, { now: NOW });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('reuses the stored list on a retry rather than re-querying the day', async () => {
    // Re-querying could return a different set — a call that arrived
    // since — and silently renumber a message the owner may already have.
    state.subFindMany.mockResolvedValue([subscription()]);
    state.digestFindUnique.mockResolvedValue({
      id: 'dig_1',
      sentAt: null,
      attempts: 1,
      callEventIds: ['c2', 'c1'],
    });
    state.callFindMany.mockResolvedValue([call('c1'), call('c2')]);

    await sendDailyDigests(prisma, { now: NOW });
    // Stored order wins over query order.
    const list = mockState.sendTemplate.mock.calls[0][3].bodyParams[1];
    expect(list.indexOf('1) ')).toBeLessThan(list.indexOf('2) '));
    expect(list).toMatch(/^1\) \+34651000002/);
  });

  it('yields to whoever won the race for today s row', async () => {
    state.subFindMany.mockResolvedValue([subscription()]);
    state.callFindMany.mockResolvedValue([call('c1')]);
    state.digestCreate.mockRejectedValue(new Error('unique violation'));

    await expect(sendDailyDigests(prisma, { now: NOW })).resolves.toMatchObject({ sent: 0, failed: 0 });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('lets one bad client fail without costing the others their digest', async () => {
    state.subFindMany.mockResolvedValue([subscription({ id: 'bad' }), subscription()]);
    state.callFindMany.mockResolvedValue([call('c1')]);
    state.digestFindUnique.mockImplementation(async ({ where }: { where: { subscriptionId_localDate: { subscriptionId: string } } }) => {
      if (where.subscriptionId_localDate.subscriptionId === 'bad') throw new Error('db blip');
      return null;
    });

    const result = await sendDailyDigests(prisma, { now: NOW });
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
  });
});

describe('applyDigestReply', () => {
  function openDigest(over: Record<string, unknown> = {}) {
    return {
      id: 'dig_1',
      callEventIds: ['c1', 'c2', 'c3'],
      respondedAt: null,
      clarifiedAt: null,
      ...over,
    };
  }

  const reply = (text: string) => applyDigestReply(prisma, { subscriptionId: 'sub_1', text }, { now: NOW });

  beforeEach(() => {
    state.subFindUnique.mockResolvedValue({
      id: 'sub_1',
      clientId: 'client_1',
      googleConnectionId: 'gbc_1',
      googleConnection: { id: 'gbc_1', clientId: 'client_1', tenantId: 'ten_1' },
      metaConnection: CONNECTION,
      client: { name: 'Juan', companyName: 'Fontanería Aurora' },
      ownerWhatsapp: '+34600111222',
      digestHour: 19,
      timezone: 'Europe/Madrid',
    });
    state.callFindMany.mockResolvedValue([{ fromNumber: '+34651000001' }, { fromNumber: '+34651000003' }]);
  });

  it('asks for reviews only from the people the owner named', async () => {
    state.digestFindFirst.mockResolvedValue(openDigest());

    await expect(reply('1 y 3')).resolves.toMatchObject({ status: 'applied', selected: 2 });
    // The ids are resolved against the STORED order, so 1 and 3 are c1/c3.
    expect(state.digestUpdate.mock.calls[0][0].data.selectedCallEventIds).toEqual(['c1', 'c3']);
    const campaign = mockState.createCampaignWithRequests.mock.calls[0][0];
    expect(campaign.channel).toBe('whatsapp');
    expect(campaign.recipients).toEqual([
      { recipient: '+34651000001', name: null },
      { recipient: '+34651000003', name: null },
    ]);
  });

  it('keeps the raw text verbatim, whatever it decided', async () => {
    state.digestFindFirst.mockResolvedValue(openDigest());
    await reply('el 1 y el 3, gracias');
    // If the owner later disputes what he asked for, this string is the
    // answer.
    expect(state.digestUpdate.mock.calls[0][0].data.rawResponse).toBe('el 1 y el 3, gracias');
  });

  it('records a "none" answer without creating a campaign', async () => {
    state.digestFindFirst.mockResolvedValue(openDigest());
    await expect(reply('ninguno')).resolves.toEqual({ status: 'none_selected' });
    expect(mockState.createCampaignWithRequests).not.toHaveBeenCalled();
    expect(state.digestUpdate.mock.calls[0][0].data.respondedAt).toBe(NOW);
  });

  it('asks for clarification exactly once', async () => {
    state.digestFindFirst.mockResolvedValue(openDigest());
    await expect(reply('gracias!')).resolves.toEqual({ status: 'clarify_sent' });
    expect(mockState.sendTemplate).toHaveBeenCalled();
    expect(state.digestUpdate.mock.calls.at(-1)?.[0].data.clarifiedAt).toBe(NOW);
  });

  it('goes quiet after a second unintelligible reply', async () => {
    // A second nag for a message he chose to ignore is how a client
    // starts muting the number he is paying us for.
    state.digestFindFirst.mockResolvedValue(openDigest({ clarifiedAt: new Date('2026-07-07T17:05:00.000Z') }));
    await expect(reply('👍')).resolves.toEqual({ status: 'ignored', reason: 'unclear_again' });
    expect(mockState.sendTemplate).not.toHaveBeenCalled();
  });

  it('ignores a reply when there is no recent digest to answer', async () => {
    state.digestFindFirst.mockResolvedValue(null);
    await expect(reply('1')).resolves.toEqual({ status: 'ignored', reason: 'no_open_digest' });
    expect(mockState.createCampaignWithRequests).not.toHaveBeenCalled();
  });

  it('only looks at digests inside the reply window', async () => {
    await reply('1');
    const since = state.digestFindFirst.mock.calls[0][0].where.sentAt.gte as Date;
    expect(NOW.getTime() - since.getTime()).toBe(DIGEST_REPLY_WINDOW_HOURS * 3600 * 1000);
  });

  it('does not act twice on the same digest', async () => {
    state.digestFindFirst.mockResolvedValue(openDigest({ respondedAt: NOW }));
    await expect(reply('todos')).resolves.toEqual({ status: 'ignored', reason: 'already_answered' });
    expect(mockState.createCampaignWithRequests).not.toHaveBeenCalled();
  });

  it('still records the reply when the client has no Google connection yet', async () => {
    state.subFindUnique.mockResolvedValue({
      id: 'sub_1',
      clientId: 'client_1',
      googleConnectionId: null,
      googleConnection: null,
      metaConnection: CONNECTION,
      client: { name: 'Juan', companyName: null },
    });
    state.digestFindFirst.mockResolvedValue(openDigest());

    // What he asked for is worth keeping even when we cannot act on it —
    // connecting Google later is a normal part of onboarding.
    await expect(reply('todos')).resolves.toMatchObject({ status: 'applied', campaignId: null });
    expect(state.digestUpdate.mock.calls[0][0].data.selectedCallEventIds).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('sweepReviewReminders', () => {
  function request(over: Record<string, unknown> = {}) {
    return {
      id: 'req_1',
      recipient: '+34651000001',
      recipientName: null,
      campaign: {
        clientId: 'client_1',
        client: { name: 'Juan', companyName: 'Fontanería Aurora' },
      },
      ...over,
    };
  }

  it('chases only what was sent, never opened, and never reminded', async () => {
    await sweepReviewReminders(prisma, { now: NOW });
    const where = state.reviewFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: 'sent', channel: 'whatsapp', clickedAt: null, remindedAt: null });
    expect(NOW.getTime() - (where.sentAt.lte as Date).getTime()).toBe(REVIEW_REMINDER_DAYS * 86400000);
  });

  it('sends the nudge and stamps it', async () => {
    state.reviewFindMany.mockResolvedValue([request()]);
    await expect(sweepReviewReminders(prisma, { now: NOW })).resolves.toMatchObject({ scanned: 1, reminded: 1 });
    expect(state.reviewUpdate.mock.calls[0][0].data).toEqual({ remindedAt: NOW });
  });

  it('does not consume the one reminder when the send fails', async () => {
    state.reviewFindMany.mockResolvedValue([request()]);
    mockState.dispatchReviewRequest.mockResolvedValue({ ok: false, error: 'meta down' });

    await expect(sweepReviewReminders(prisma, { now: NOW })).resolves.toMatchObject({ failed: 1, reminded: 0 });
    expect(state.reviewUpdate).not.toHaveBeenCalled();
  });

  it('resolves the sender once per client, not once per request', async () => {
    state.reviewFindMany.mockResolvedValue([request(), request({ id: 'req_2' }), request({ id: 'req_3' })]);
    await sweepReviewReminders(prisma, { now: NOW });
    // A campaign of thirty would otherwise decrypt the same token thirty
    // times.
    expect(state.connectionFindFirst).toHaveBeenCalledTimes(1);
  });

  it('skips a client with no usable WhatsApp connection instead of failing', async () => {
    state.reviewFindMany.mockResolvedValue([request()]);
    mockState.metaSenderFor.mockReturnValue(null);

    await expect(sweepReviewReminders(prisma, { now: NOW })).resolves.toMatchObject({ reminded: 0, failed: 0 });
    expect(mockState.dispatchReviewRequest).not.toHaveBeenCalled();
  });
});
