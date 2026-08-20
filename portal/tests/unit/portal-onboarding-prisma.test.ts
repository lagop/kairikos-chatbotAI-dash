// =============================================================================
// WP-25 (KAIA-13702 follow-up) — getOnboarding() must query Prisma directly
// when the DB is configured and the session resolves to a real database
// client, instead of relying exclusively on portalFetch('/portal/onboarding',
// ...), which is gated on `isBackendConfigured = Boolean(PORTAL_API_BASE_URL)`.
// That gate is false on Vercel production (see the KAIA-13702 comment on
// listAdminClients() in portal-data.ts — same root cause, different
// function), so every real customer with a working NextAuth session and a
// real ChatbotClientUser row was silently served the Acme
// MOCK_TIMELINE_INTERNAL fixture instead of their own onboarding timeline.
//
// Mirrors the test conventions in portal-list-admin-clients.test.ts (mock
// @/lib/prisma with isDatabaseConfigured: true) plus a mock of
// resolveClientFromSession() from portal-session.ts, since getOnboarding()
// needs a resolved clientId to query ChatbotActivity by.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const resolveClientFromSession = vi.fn();
const fetchMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotActivity: {
      findMany: (...args: unknown[]) => findMany(...args),
    },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/portal-session', () => ({
  resolveClientFromSession: (...args: unknown[]) => resolveClientFromSession(...args),
}));

vi.mock('@/lib/supabase', () => ({
  isBackendConfigured: false,
  PORTAL_API_BASE_URL: '',
  SUPABASE_ANON_KEY: 'anon-test',
}));

vi.stubGlobal('fetch', fetchMock);

import { getOnboarding, MOCK_TIMELINE } from '@/lib/portal-data';

describe('getOnboarding (WP-25, prisma read when DB configured + real session)', () => {
  beforeEach(() => {
    findMany.mockReset();
    resolveClientFromSession.mockReset();
    fetchMock.mockReset();
  });

  afterEach(() => {
    findMany.mockReset();
    resolveClientFromSession.mockReset();
    fetchMock.mockReset();
  });

  it('queries ChatbotActivity for the resolved database client, not the mock', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-1',
      email: 'owner@realclient.example.com',
      source: 'database',
    });
    findMany.mockResolvedValueOnce([
      {
        id: 'evt-1',
        milestone: 'T+0',
        completedAt: new Date('2026-08-01T10:00:00.000Z'),
        notes: 'Bienvenida enviada',
      },
    ]);

    const result = await getOnboarding('any-token');

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0] as { where: { clientId: string; productCode: string } };
    expect(arg.where).toEqual({ clientId: 'client-real-1', productCode: 'chatbot' });
    expect(result).toEqual([
      {
        id: 'evt-1',
        step: 't_plus_0',
        label: 'Bienvenida y acceso al portal',
        description: 'Bienvenida enviada',
        occurredAt: '2026-08-01T10:00:00.000Z',
        status: 'done',
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns [] (not the mock) when the real client has no ChatbotActivity rows yet', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-fresh',
      email: 'fresh@realclient.example.com',
      source: 'database',
    });
    findMany.mockResolvedValueOnce([]);

    const result = await getOnboarding('any-token');
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('marks an un-completed milestone as current', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-2',
      email: 'owner2@realclient.example.com',
      source: 'database',
    });
    findMany.mockResolvedValueOnce([
      { id: 'evt-2', milestone: 'T+3', completedAt: null, notes: null },
    ]);

    const result = await getOnboarding('any-token');
    expect(result[0].status).toBe('current');
    expect(result[0].occurredAt).toBeNull();
    expect(result[0].description).toBe('');
  });

  it('falls back to legacy portalFetch/mock when resolveClientFromSession returns null (e.g. operator session)', async () => {
    resolveClientFromSession.mockResolvedValueOnce(null);

    const result = await getOnboarding('any-token');
    expect(findMany).not.toHaveBeenCalled();
    // isBackendConfigured is false in this test's supabase mock, so
    // portalFetch short-circuits and getOnboarding falls through to the mock.
    expect(result).toBe(MOCK_TIMELINE);
  });

  it('falls back to legacy portalFetch/mock when the resolved session is mock_dev, not database', async () => {
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'mock-client',
      email: 'dev@example.com',
      source: 'mock_dev',
    });

    const result = await getOnboarding('dev-mock');
    expect(findMany).not.toHaveBeenCalled();
    expect(result).toBe(MOCK_TIMELINE);
  });

  it('falls back to legacy portalFetch/mock when Prisma throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    resolveClientFromSession.mockResolvedValueOnce({
      clientId: 'client-real-3',
      email: 'owner3@realclient.example.com',
      source: 'database',
    });
    findMany.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await getOnboarding('any-token');
    expect(result).toBe(MOCK_TIMELINE);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[getOnboarding]'),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
