// =============================================================================
// createClientByOperator (src/lib/admin-client-onboarding.ts) — alta
// manual de cliente desde el panel de operador.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  findUniqueChatbotClient: vi.fn(),
  createChatbotClient: vi.fn(),
  createUser: vi.fn(),
  createChatbotClientUser: vi.fn(),
  updateManyPasswordResetToken: vi.fn(),
  createPasswordResetToken: vi.fn(),
}));

const mockTx = {
  chatbotClient: { create: (...args: unknown[]) => mockState.createChatbotClient(...args) },
  user: { create: (...args: unknown[]) => mockState.createUser(...args) },
  chatbotClientUser: { create: (...args: unknown[]) => mockState.createChatbotClientUser(...args) },
};

const mockPrisma = {
  $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  chatbotClient: { findUnique: (...args: unknown[]) => mockState.findUniqueChatbotClient(...args) },
  passwordResetToken: {
    updateMany: (...args: unknown[]) => mockState.updateManyPasswordResetToken(...args),
    create: (...args: unknown[]) => mockState.createPasswordResetToken(...args),
  },
} as unknown as import('@prisma/client').PrismaClient;

beforeEach(() => {
  mockState.findUniqueChatbotClient.mockReset().mockResolvedValue(null);
  mockState.createChatbotClient.mockReset().mockResolvedValue({ id: 'client_new_1' });
  mockState.createUser.mockReset().mockResolvedValue({ id: 'user_new_1' });
  mockState.createChatbotClientUser.mockReset().mockResolvedValue({ id: 'cu_new_1' });
  mockState.updateManyPasswordResetToken.mockReset().mockResolvedValue({ count: 0 });
  mockState.createPasswordResetToken.mockReset().mockResolvedValue({ id: 'prt_1' });
});

describe('createClientByOperator', () => {
  it('creates ChatbotClient + User + ChatbotClientUser, email normalised to lowercase/trim', async () => {
    const { createClientByOperator } = await import('@/lib/admin-client-onboarding');
    const result = await createClientByOperator(mockPrisma, {
      email: '  Aurora@Example.com  ',
      name: 'Aurora Demo',
      companyName: 'Peluquería Aurora',
    });

    expect(result).toEqual({ ok: true, clientId: 'client_new_1', clientUserId: 'cu_new_1', isNewClient: true });
    expect(mockState.createChatbotClient).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'aurora@example.com', tier: 'starter', state: 'in-progress' }),
      }),
    );
    expect(mockState.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: 'aurora@example.com', passwordHash: null, role: 'client' }) }),
    );
    expect(mockState.createChatbotClientUser).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nextAuthEmail: 'aurora@example.com', clientId: 'client_new_1', userId: 'user_new_1' }),
      }),
    );
  });

  it('refuses to create a second client for an email that already exists', async () => {
    mockState.findUniqueChatbotClient.mockResolvedValueOnce({ id: 'client_existing' });
    const { createClientByOperator } = await import('@/lib/admin-client-onboarding');
    const result = await createClientByOperator(mockPrisma, {
      email: 'aurora@example.com',
      name: 'Aurora',
      companyName: 'Peluquería Aurora',
    });

    expect(result).toEqual({ ok: false, error: 'client_already_exists' });
    expect(mockState.createChatbotClient).not.toHaveBeenCalled();
  });
});

describe('mintSetupPasswordToken', () => {
  it('burns unused tokens for the email, stores only the hash, and returns the plaintext token', async () => {
    const { mintSetupPasswordToken } = await import('@/lib/admin-client-onboarding');
    const token = await mintSetupPasswordToken(mockPrisma, '  Aurora@Example.com  ');

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(mockState.updateManyPasswordResetToken).toHaveBeenCalledWith({
      where: { email: 'aurora@example.com', usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
    const createCall = mockState.createPasswordResetToken.mock.calls[0][0];
    expect(createCall.data.email).toBe('aurora@example.com');
    expect(createCall.data.tokenHash).not.toBe(token);
    expect(createCall.data.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
