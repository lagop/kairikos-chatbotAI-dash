import { describe, it, expect, vi } from 'vitest';

const baseRow = {
  id: 'cklient_a',
  companyName: 'Acme Corp',
  name: 'Acme Corp',
  email: 'qa-test-client-a@kairikos.com',
  tier: 'pro',
  stripeCustomerId: 'cus_test_client_a',
  state: 'live',
  goLiveAt: new Date('2026-05-29T09:00:00.000Z'),
  createdAt: new Date('2026-05-22T10:00:00.000Z'),
};

describe('listAdminClients (KAIA-13114)', () => {
  it('returns the three dev-mock fixtures when the DB is not configured', async () => {
    vi.resetModules();
    const findMany = vi.fn();
    vi.doMock('@/lib/prisma', () => ({
      prisma: { chatbotClient: { findMany } },
      isDatabaseConfigured: false,
    }));
    const { listAdminClients } = await import('@/lib/portal-data');
    const result = await listAdminClients();
    expect(findMany).not.toHaveBeenCalled();
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.companyName)).toEqual([
      'Acme Corp',
      'Globex Inc',
      'Starter S.L.',
    ]);
  });

  it('reads live rows from prisma.chatbotClient when the DB is configured', async () => {
    vi.resetModules();
    const findMany = vi.fn();
    vi.doMock('@/lib/prisma', () => ({
      prisma: { chatbotClient: { findMany } },
      isDatabaseConfigured: true,
    }));
    const { listAdminClients } = await import('@/lib/portal-data');
    findMany.mockResolvedValueOnce([baseRow]);
    const result = await listAdminClients();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: baseRow.id,
      slug: baseRow.id,
      companyName: baseRow.companyName,
      primaryContactEmail: baseRow.email,
      tier: 'pro',
      onboardingStatus: 'live',
      goLiveDate: '2026-05-29T09:00:00.000Z',
      chatbotSpaceId: null,
    });
  });

  it('maps unknown state values to in_progress', async () => {
    vi.resetModules();
    const findMany = vi.fn();
    vi.doMock('@/lib/prisma', () => ({
      prisma: { chatbotClient: { findMany } },
      isDatabaseConfigured: true,
    }));
    const { listAdminClients } = await import('@/lib/portal-data');
    findMany.mockResolvedValueOnce([{ ...baseRow, id: 'cklient_b', state: 'go-live-pending' }]);
    const result = await listAdminClients();
    expect(result[0].onboardingStatus).toBe('in_progress');
  });

  it('forwards the search arg as a case-insensitive OR filter on companyName + email', async () => {
    vi.resetModules();
    const findMany = vi.fn();
    vi.doMock('@/lib/prisma', () => ({
      prisma: { chatbotClient: { findMany } },
      isDatabaseConfigured: true,
    }));
    const { listAdminClients } = await import('@/lib/portal-data');
    findMany.mockResolvedValueOnce([baseRow]);
    await listAdminClients('orly');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { companyName: { contains: 'orly', mode: 'insensitive' } },
            { email: { contains: 'orly', mode: 'insensitive' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('omits the where clause when no search is supplied', async () => {
    vi.resetModules();
    const findMany = vi.fn();
    vi.doMock('@/lib/prisma', () => ({
      prisma: { chatbotClient: { findMany } },
      isDatabaseConfigured: true,
    }));
    const { listAdminClients } = await import('@/lib/portal-data');
    findMany.mockResolvedValueOnce([baseRow]);
    await listAdminClients('');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: undefined,
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('returns an empty array when prisma throws (no crash for the operator)', async () => {
    vi.resetModules();
    const findMany = vi.fn();
    vi.doMock('@/lib/prisma', () => ({
      prisma: { chatbotClient: { findMany } },
      isDatabaseConfigured: true,
    }));
    const { listAdminClients } = await import('@/lib/portal-data');
    findMany.mockRejectedValueOnce(new Error('connection refused'));
    const result = await listAdminClients();
    expect(result).toEqual([]);
  });
});
