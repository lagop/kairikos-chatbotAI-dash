// =============================================================================
// self-serve-onboarding.ts (WP-31) — public signup, no operator involved.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fase 4 multi-instancia — el sitio de cada contratación tiene sus propios
// tests (client-site.test.ts); aquí solo se comprueba que se pide.
const clientSiteMock = vi.hoisted(() => ({
  assignSiteToNewContract: vi.fn(),
  ensurePrimaryClientSite: vi.fn(),
}));
vi.mock('@/lib/client-site', () => clientSiteMock);

const mockState = vi.hoisted(() => ({
  findUniqueChatbotClient: vi.fn(),
  createChatbotClient: vi.fn(),
  createUser: vi.fn(),
  createChatbotClientUser: vi.fn(),
  updateManyEmailVerificationToken: vi.fn(),
  createEmailVerificationToken: vi.fn(),
  findFirstEmailVerificationToken: vi.fn(),
  updateEmailVerificationToken: vi.fn(),
  updateManyChatbotClient: vi.fn(),
  transactionArray: vi.fn(),
}));

const mockTx = {
  chatbotClient: { create: (...args: unknown[]) => mockState.createChatbotClient(...args) },
  user: { create: (...args: unknown[]) => mockState.createUser(...args) },
  chatbotClientUser: { create: (...args: unknown[]) => mockState.createChatbotClientUser(...args) },
};

const mockPrisma = {
  $transaction: (arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: typeof mockTx) => unknown)(mockTx);
    return mockState.transactionArray(arg);
  },
  chatbotClient: {
    findUnique: (...args: unknown[]) => mockState.findUniqueChatbotClient(...args),
    updateMany: (...args: unknown[]) => mockState.updateManyChatbotClient(...args),
  },
  emailVerificationToken: {
    updateMany: (...args: unknown[]) => mockState.updateManyEmailVerificationToken(...args),
    create: (...args: unknown[]) => mockState.createEmailVerificationToken(...args),
    findFirst: (...args: unknown[]) => mockState.findFirstEmailVerificationToken(...args),
    update: (...args: unknown[]) => mockState.updateEmailVerificationToken(...args),
  },
} as unknown as import('@prisma/client').PrismaClient;

beforeEach(() => {
  mockState.findUniqueChatbotClient.mockReset().mockResolvedValue(null);
  mockState.createChatbotClient.mockReset().mockResolvedValue({ id: 'client_new_1' });
  mockState.createUser.mockReset().mockResolvedValue({ id: 'user_new_1' });
  mockState.createChatbotClientUser.mockReset().mockResolvedValue({ id: 'cu_new_1' });
  mockState.updateManyEmailVerificationToken.mockReset().mockResolvedValue({ count: 0 });
  mockState.createEmailVerificationToken.mockReset().mockResolvedValue({ id: 'evt_1' });
  mockState.findFirstEmailVerificationToken.mockReset().mockResolvedValue(null);
  mockState.updateEmailVerificationToken.mockReset().mockResolvedValue({});
  mockState.updateManyChatbotClient.mockReset().mockResolvedValue({ count: 1 });
  mockState.transactionArray.mockReset().mockResolvedValue([]);
});

describe('createClientForSelfServe', () => {
  it('creates ChatbotClient (tosAcceptedAt stamped) + User (password already set) + ChatbotClientUser', async () => {
    const { createClientForSelfServe } = await import('@/lib/self-serve-onboarding');
    const result = await createClientForSelfServe(mockPrisma, {
      email: '  Aurora@Example.com  ',
      name: 'Aurora Demo',
      companyName: 'Peluquería Aurora',
      passwordHash: 'argon2id$hashed',
    });

    expect(result).toEqual({ ok: true, clientId: 'client_new_1', clientUserId: 'cu_new_1' });
    expect(mockState.createChatbotClient).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'aurora@example.com', tosAcceptedAt: expect.any(Date) }),
      }),
    );
    expect(mockState.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'aurora@example.com', passwordHash: 'argon2id$hashed', role: 'client' }),
      }),
    );
  });

  it('refuses a second account for an email that already exists', async () => {
    mockState.findUniqueChatbotClient.mockResolvedValueOnce({ id: 'client_existing' });
    const { createClientForSelfServe } = await import('@/lib/self-serve-onboarding');
    const result = await createClientForSelfServe(mockPrisma, {
      email: 'aurora@example.com',
      name: 'Aurora',
      companyName: 'Peluquería Aurora',
      passwordHash: 'argon2id$hashed',
    });

    expect(result).toEqual({ ok: false, error: 'client_already_exists' });
    expect(mockState.createChatbotClient).not.toHaveBeenCalled();
  });
});

describe('mintEmailVerificationToken', () => {
  it('burns unused tokens for the email and returns a fresh plaintext token', async () => {
    const { mintEmailVerificationToken } = await import('@/lib/self-serve-onboarding');
    const token = await mintEmailVerificationToken(mockPrisma, '  Aurora@Example.com  ');

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(mockState.updateManyEmailVerificationToken).toHaveBeenCalledWith({
      where: { email: 'aurora@example.com', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    const createCall = mockState.createEmailVerificationToken.mock.calls[0][0];
    expect(createCall.data.email).toBe('aurora@example.com');
    expect(createCall.data.tokenHash).not.toBe(token);
  });
});

describe('verifyEmailToken', () => {
  it('returns invalid_or_expired_token when no matching row exists', async () => {
    const { verifyEmailToken } = await import('@/lib/self-serve-onboarding');
    const result = await verifyEmailToken(mockPrisma, { email: 'aurora@example.com', token: 'a'.repeat(64) });
    expect(result).toEqual({ ok: false, error: 'invalid_or_expired_token' });
    expect(mockState.transactionArray).not.toHaveBeenCalled();
  });

  it('marks ChatbotClient.emailVerifiedAt and burns the token on a valid match', async () => {
    mockState.findFirstEmailVerificationToken.mockResolvedValueOnce({ id: 'evt_1' });
    const { verifyEmailToken } = await import('@/lib/self-serve-onboarding');
    const result = await verifyEmailToken(mockPrisma, { email: 'aurora@example.com', token: 'a'.repeat(64) });

    expect(result).toEqual({ ok: true });
    expect(mockState.transactionArray).toHaveBeenCalledTimes(1);
  });
});
