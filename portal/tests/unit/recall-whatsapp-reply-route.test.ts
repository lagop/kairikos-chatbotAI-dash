// =============================================================================
// WP-XX (Fase 10) — unit tests for POST /api/internal/recall/whatsapp-reply.
//
// This route decides whether an inbound WhatsApp is an instruction or a
// conversation, so both directions of that judgement are dangerous:
// treating a customer's chat as an instruction would send review requests
// nobody asked for, and treating the owner's "1 y 3" as chat would
// silently drop the answer the whole feature depends on.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const mockState = vi.hoisted(() => ({
  applyDigestReply: vi.fn(),
  connectionFindFirst: vi.fn(),
  subscriptionFindFirst: vi.fn(),
}));

vi.mock('@/lib/recall-reviews', () => ({
  applyDigestReply: (...a: unknown[]) => mockState.applyDigestReply(...a),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    metaChannelConnection: { findFirst: (...a: unknown[]) => mockState.connectionFindFirst(...a) },
    recallSubscription: { findFirst: (...a: unknown[]) => mockState.subscriptionFindFirst(...a) },
  },
}));

const VALID_KEY = 'test_portal_api_key';

function makeRequest(body: unknown, key: string | null = VALID_KEY) {
  return {
    headers: new Headers(key ? { 'x-kairikos-internal-key': key } : {}),
    json: async () => body,
  } as unknown as NextRequest;
}

async function post(req: NextRequest) {
  const { POST } = await import('@/app/api/internal/recall/whatsapp-reply/route');
  return POST(req);
}

const VALID = { phoneNumberId: 'phone_1', from: '34600111222', text: '1 y 3' };

beforeEach(() => {
  process.env.PORTAL_API_KEY = VALID_KEY;
  for (const fn of Object.values(mockState)) fn.mockReset();
  mockState.connectionFindFirst.mockResolvedValue({ id: 'conn_1', clientId: 'client_1' });
  mockState.subscriptionFindFirst.mockResolvedValue({ id: 'sub_1', ownerWhatsapp: '+34600111222' });
  mockState.applyDigestReply.mockResolvedValue({ status: 'applied', selected: 2, campaignId: 'camp_1' });
});

describe('POST /api/internal/recall/whatsapp-reply', () => {
  it('rejects an unauthenticated call', async () => {
    const res = await post(makeRequest(VALID, null));
    expect(res.status).toBe(401);
    expect(mockState.applyDigestReply).not.toHaveBeenCalled();
  });

  it('rejects a malformed body', async () => {
    const res = await post(makeRequest({ from: '34600111222' }));
    expect(res.status).toBe(400);
    expect(mockState.applyDigestReply).not.toHaveBeenCalled();
  });

  it('applies the reply when the owner answers his own digest', async () => {
    const res = await post(makeRequest(VALID));
    const body = await res.clone().json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ handled: true, outcome: { status: 'applied', selected: 2 } });
    expect(mockState.applyDigestReply).toHaveBeenCalledWith(expect.anything(), {
      subscriptionId: 'sub_1',
      text: '1 y 3',
    });
  });

  it("matches the owner even though Meta's wa_id drops the leading +", async () => {
    // A naive === would never match, and every digest reply would fall
    // through as ordinary conversation — the feature would look built and
    // never work once.
    mockState.subscriptionFindFirst.mockResolvedValue({ id: 'sub_1', ownerWhatsapp: '+34 600 11 12 22' });
    const body = await (await post(makeRequest({ ...VALID, from: '34600111222' }))).clone().json();
    expect(body.handled).toBe(true);
  });

  it('refuses to act on a message from anyone but the owner', async () => {
    // Otherwise a customer replying "1" to an unrelated message would be
    // ordering review invitations on the client's behalf.
    const body = await (await post(makeRequest({ ...VALID, from: '34699888777' }))).clone().json();
    expect(body).toEqual({ handled: false, reason: 'not_owner' });
    expect(mockState.applyDigestReply).not.toHaveBeenCalled();
  });

  it('hands ordinary conversation back to n8n rather than swallowing it', async () => {
    mockState.applyDigestReply.mockResolvedValue({ status: 'ignored', reason: 'no_open_digest' });
    const res = await post(makeRequest({ ...VALID, text: '¿nos vemos mañana?' }));
    const body = await res.clone().json();

    // 200 with handled:false is the normal answer, not an error — n8n
    // routes it onward to the conversation endpoint.
    expect(res.status).toBe(200);
    expect(body).toEqual({ handled: false, reason: 'no_open_digest' });
  });

  it('reports an unknown or inactive number as unhandled, not as a failure', async () => {
    mockState.connectionFindFirst.mockResolvedValue(null);
    const res = await post(makeRequest(VALID));
    expect(res.status).toBe(200);
    expect((await res.clone().json()).reason).toBe('unknown_number');
  });

  it('reports a client with no recall subscription as unhandled', async () => {
    mockState.subscriptionFindFirst.mockResolvedValue(null);
    const body = await (await post(makeRequest(VALID))).clone().json();
    expect(body).toEqual({ handled: false, reason: 'no_subscription' });
  });

  it('still reports handled when the digest was already answered', async () => {
    // Not "unhandled": it WAS about the digest, so it must not be
    // reprocessed as a chatbot conversation.
    mockState.applyDigestReply.mockResolvedValue({ status: 'ignored', reason: 'already_answered' });
    const body = await (await post(makeRequest(VALID))).clone().json();
    expect(body.handled).toBe(true);
  });
});
