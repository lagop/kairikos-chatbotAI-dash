// =============================================================================
// WP-25 follow-up — listConversations()/getConversation()/getBilling() must
// query Prisma directly when the DB is configured and the session resolves
// to a real database client, instead of relying exclusively on
// portalFetch(...), which is gated on
// `isBackendConfigured = Boolean(PORTAL_API_BASE_URL)`. That gate is false
// on Vercel production (see the KAIA-11955 comment on buildApiUrl() in
// portal-data.ts), so every real customer with a working NextAuth session
// and a real ChatbotClientUser row was silently served the Acme mock
// fixtures (MOCK_CONVERSATIONS / MOCK_BILLING) instead of their own data —
// the same bug class getOnboarding() had (see
// portal-onboarding-prisma.test.ts).
//
// Mirrors that file's mocking conventions, plus a mock of
// getBillingForClient() from stripe-billing.ts for the getBilling() cases.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const conversationFindMany = vi.fn();
const conversationFindFirst = vi.fn();
const chatbotClientFindUnique = vi.fn();
const resolveClientFromSession = vi.fn();
const getBillingForClient = vi.fn();
const fetchMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotConversation: {
      findMany: (...args: unknown[]) => conversationFindMany(...args),
      findFirst: (...args: unknown[]) => conversationFindFirst(...args),
    },
    chatbotClient: {
      findUnique: (...args: unknown[]) => chatbotClientFindUnique(...args),
    },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => resolveClientFromSession(...args),
}));

vi.mock('@/lib/stripe-billing', () => ({
  getBillingForClient: (...args: unknown[]) => getBillingForClient(...args),
}));

vi.mock('@/lib/supabase', () => ({
  isBackendConfigured: false,
  PORTAL_API_BASE_URL: '',
  SUPABASE_ANON_KEY: 'anon-test',
}));

vi.stubGlobal('fetch', fetchMock);

import { getBilling, getConversation, listConversations, MOCK_BILLING_EXPORT, MOCK_CONVERSATIONS } from '@/lib/portal-data';

function resetAll() {
  conversationFindMany.mockReset();
  conversationFindFirst.mockReset();
  chatbotClientFindUnique.mockReset();
  resolveClientFromSession.mockReset();
  getBillingForClient.mockReset();
  fetchMock.mockReset();
}

describe('listConversations (WP-25 follow-up, prisma read when DB configured + real session)', () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  it('queries ChatbotConversation for the resolved database client, not the mock', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-1',
      email: 'owner@realclient.example.com',
      source: 'database',
    });
    conversationFindMany.mockResolvedValueOnce([
      { id: 'cnv-1', startedAt: new Date('2026-08-10T09:00:00.000Z'), duration: 90, outcome: 'resolved' },
    ]);

    const result = await listConversations('any-token');

    expect(conversationFindMany).toHaveBeenCalledTimes(1);
    const arg = conversationFindMany.mock.calls[0][0] as { where: { clientId: string } };
    expect(arg.where).toEqual({ clientId: 'client-real-1' });
    expect(result).toEqual([
      {
        id: 'cnv-1',
        startedAt: '2026-08-10T09:00:00.000Z',
        durationSeconds: 90,
        outcome: 'resolved',
        channel: 'other',
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns [] (not the mock) when the real client has no conversations yet', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-fresh',
      email: 'fresh@realclient.example.com',
      source: 'database',
    });
    conversationFindMany.mockResolvedValueOnce([]);

    const result = await listConversations('any-token');
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to legacy portalFetch/mock when resolveClientFromSession returns null', async () => {
    resolveClientFromSession.mockResolvedValueOnce(null);
    const result = await listConversations('any-token');
    expect(conversationFindMany).not.toHaveBeenCalled();
    expect(result).toBe(MOCK_CONVERSATIONS);
  });

  it('falls back to legacy portalFetch/mock when the resolved session is mock_dev', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'mock-client',
      email: 'dev@example.com',
      source: 'mock_dev',
    });
    const result = await listConversations('dev-mock');
    expect(conversationFindMany).not.toHaveBeenCalled();
    expect(result).toBe(MOCK_CONVERSATIONS);
  });

  it('falls back to legacy portalFetch/mock when Prisma throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-2',
      email: 'owner2@realclient.example.com',
      source: 'database',
    });
    conversationFindMany.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await listConversations('any-token');
    expect(result).toBe(MOCK_CONVERSATIONS);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[listConversations]'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

describe('getConversation (WP-25 follow-up, prisma read when DB configured + real session)', () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  it('queries the resolved client scoped conversation and maps the transcript', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-1',
      email: 'owner@realclient.example.com',
      source: 'database',
    });
    conversationFindFirst.mockResolvedValueOnce({
      id: 'cnv-1',
      startedAt: new Date('2026-08-10T09:00:00.000Z'),
      duration: 30,
      outcome: 'escalated',
      transcript: {
        channel: 'whatsapp',
        messages: [{ id: 'm1', role: 'user', content: 'Hola', at: '2026-08-10T09:00:01.000Z' }],
      },
    });

    const result = await getConversation('any-token', 'cnv-1');

    expect(conversationFindFirst).toHaveBeenCalledTimes(1);
    const arg = conversationFindFirst.mock.calls[0][0] as { where: { id: string; clientId: string } };
    expect(arg.where).toEqual({ id: 'cnv-1', clientId: 'client-real-1' });
    expect(result).toEqual({
      id: 'cnv-1',
      startedAt: '2026-08-10T09:00:00.000Z',
      endedAt: '2026-08-10T09:00:30.000Z',
      outcome: 'escalated',
      channel: 'whatsapp',
      messages: [{ id: 'm1', role: 'user', content: 'Hola', at: '2026-08-10T09:00:01.000Z' }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null (not the mock) when the real client has no conversation with that id', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-1',
      email: 'owner@realclient.example.com',
      source: 'database',
    });
    conversationFindFirst.mockResolvedValueOnce(null);

    const result = await getConversation('any-token', 'does-not-exist');
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to legacy portalFetch/mock when resolveClientFromSession returns null', async () => {
    resolveClientFromSession.mockResolvedValueOnce(null);
    const result = await getConversation('any-token', MOCK_CONVERSATIONS[0].id);
    expect(conversationFindFirst).not.toHaveBeenCalled();
    expect(result?.id).toBe(MOCK_CONVERSATIONS[0].id);
  });

  it('falls back to legacy portalFetch/mock when Prisma throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-1',
      email: 'owner@realclient.example.com',
      source: 'database',
    });
    conversationFindFirst.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await getConversation('any-token', MOCK_CONVERSATIONS[0].id);
    expect(result?.id).toBe(MOCK_CONVERSATIONS[0].id);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[getConversation]'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});

describe('getBilling (WP-25 follow-up, prisma read when DB configured + real session)', () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  it('projects ChatbotClient.tier + getBillingForClient() for the resolved database client, not the mock', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-1',
      email: 'owner@realclient.example.com',
      source: 'database',
    });
    chatbotClientFindUnique.mockResolvedValueOnce({ tier: 'premium' });
    getBillingForClient.mockResolvedValueOnce({
      tenantId: null,
      customer: { stripeCustomerId: 'cus_real_1', portalUrl: 'https://billing.stripe.com/p/session/cus_real_1' },
      subscriptions: [],
      oneTimePurchases: [],
      upcomingInvoice: { amountDueCents: 49900, currency: 'eur', dueAt: '2026-09-01T00:00:00.000Z' },
      recentInvoices: [],
    });

    const result = await getBilling('any-token');

    expect(getBillingForClient).toHaveBeenCalledWith('client-real-1');
    expect(result).toEqual({
      tier: 'premium',
      tierLabel: expect.any(String),
      monthlyFeeCents: expect.any(Number),
      currency: 'EUR',
      nextInvoiceDate: '2026-09-01T00:00:00.000Z',
      nextInvoiceAmountCents: 49900,
      stripeCustomerPortalUrl: 'https://billing.stripe.com/p/session/cus_real_1',
      stripeCustomerId: 'cus_real_1',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to legacy portalFetch/mock when resolveClientFromSession returns null', async () => {
    resolveClientFromSession.mockResolvedValueOnce(null);
    const result = await getBilling('any-token');
    expect(getBillingForClient).not.toHaveBeenCalled();
    expect(result).toBe(MOCK_BILLING_EXPORT);
  });

  it('falls back to legacy portalFetch/mock when the resolved session is mock_dev', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'mock-client',
      email: 'dev@example.com',
      source: 'mock_dev',
    });
    const result = await getBilling('dev-mock');
    expect(getBillingForClient).not.toHaveBeenCalled();
    expect(result).toBe(MOCK_BILLING_EXPORT);
  });

  it('falls back to legacy portalFetch/mock when getBillingForClient returns null', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-1',
      email: 'owner@realclient.example.com',
      source: 'database',
    });
    chatbotClientFindUnique.mockResolvedValueOnce({ tier: 'pro' });
    getBillingForClient.mockResolvedValueOnce(null);

    const result = await getBilling('any-token');
    expect(result).toBe(MOCK_BILLING_EXPORT);
  });

  it('falls back to legacy portalFetch/mock when Prisma throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-1',
      email: 'owner@realclient.example.com',
      source: 'database',
    });
    chatbotClientFindUnique.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await getBilling('any-token');
    expect(result).toBe(MOCK_BILLING_EXPORT);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[getBilling]'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });

  it('falls back to starter tier when ChatbotClient.tier has an unrecognized value', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-1',
      email: 'owner@realclient.example.com',
      source: 'database',
    });
    chatbotClientFindUnique.mockResolvedValueOnce({ tier: 'legacy-unknown-tier' });
    getBillingForClient.mockResolvedValueOnce({
      tenantId: null,
      customer: { stripeCustomerId: null, portalUrl: null },
      subscriptions: [],
      oneTimePurchases: [],
      upcomingInvoice: null,
      recentInvoices: [],
    });

    const result = await getBilling('any-token');
    expect(result.tier).toBe('starter');
  });
});
