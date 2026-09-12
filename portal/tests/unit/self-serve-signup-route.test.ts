// =============================================================================
// POST /api/public/self-serve-signup (WP-31) — public account + product
// pick, no session, no operator.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  findUniqueProduct: vi.fn(),
  hashPassword: vi.fn(),
  rateLimiterCheck: vi.fn(),
  createClientForSelfServe: vi.fn(),
  mintEmailVerificationToken: vi.fn(),
  sendVerifyEmail: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/operator-crypto', () => ({
  hashPassword: (...args: unknown[]) => mockState.hashPassword(...args),
  InMemoryRateLimiter: class {
    check(...args: unknown[]) {
      return mockState.rateLimiterCheck(...args);
    }
  },
}));

vi.mock('@/lib/self-serve-onboarding', () => ({
  createClientForSelfServe: (...args: unknown[]) => mockState.createClientForSelfServe(...args),
  mintEmailVerificationToken: (...args: unknown[]) => mockState.mintEmailVerificationToken(...args),
}));

vi.mock('@/lib/auth-email', () => ({
  sendVerifyEmail: (...args: unknown[]) => mockState.sendVerifyEmail(...args),
}));

vi.mock('@/lib/observability', () => ({ logError: (...args: unknown[]) => mockState.logError(...args) }));

vi.mock('@/lib/prisma', () => ({
  prisma: { product: { findUnique: (...args: unknown[]) => mockState.findUniqueProduct(...args) } },
  isDatabaseConfigured: true,
}));

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';

function makeRequest(body: unknown, ip = '203.0.113.5') {
  return {
    json: async () => body,
    headers: new Headers({ 'x-forwarded-for': ip }),
  } as unknown as Parameters<typeof import('@/app/api/public/self-serve-signup/route').POST>[0];
}

const VALID_BODY = {
  email: 'aurora@example.com',
  name: 'Aurora',
  companyName: 'Peluquería Aurora',
  password: 'super-secret-8',
  productId: PRODUCT_ID,
  tosAccepted: true,
};

beforeEach(() => {
  mockState.findUniqueProduct.mockReset().mockResolvedValue({ id: PRODUCT_ID, isActive: true, selfServeEligible: true });
  mockState.hashPassword.mockReset().mockResolvedValue('argon2id$hashed');
  mockState.rateLimiterCheck.mockReset().mockReturnValue(true);
  mockState.createClientForSelfServe.mockReset().mockResolvedValue({ ok: true, clientId: 'client_1', clientUserId: 'cu_1' });
  mockState.mintEmailVerificationToken.mockReset().mockResolvedValue('a'.repeat(64));
  mockState.sendVerifyEmail.mockReset().mockResolvedValue(undefined);
  mockState.logError.mockReset();
});

describe('POST /api/public/self-serve-signup', () => {
  it('429s when the IP rate limit is exceeded', async () => {
    mockState.rateLimiterCheck.mockReturnValueOnce(false);
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(429);
    expect(mockState.createClientForSelfServe).not.toHaveBeenCalled();
  });

  it('400s on an invalid body', async () => {
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest({ email: 'not-an-email' }));
    expect(res.status).toBe(400);
  });

  it('400s when the honeypot field is filled', async () => {
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest({ ...VALID_BODY, website: 'https://spam.example' }));
    expect(res.status).toBe(400);
    expect(mockState.createClientForSelfServe).not.toHaveBeenCalled();
  });

  it('400s when tosAccepted is not literally true', async () => {
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest({ ...VALID_BODY, tosAccepted: false }));
    expect(res.status).toBe(400);
  });

  it('400s when the product is not self-serve eligible', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ id: PRODUCT_ID, code: 'recall', isActive: true, selfServeEligible: false });
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest(VALID_BODY));
    const body = await res.clone().json();
    expect(res.status).toBe(400);
    expect(body.error).toBe('product_not_self_serve_eligible');
    expect(mockState.createClientForSelfServe).not.toHaveBeenCalled();
  });

  it("allows 'web' even with selfServeEligible=false — account creation is fine, only Stripe payment is excluded for it", async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ id: PRODUCT_ID, code: 'web', isActive: true, selfServeEligible: false });
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(201);
    expect(mockState.createClientForSelfServe).toHaveBeenCalled();
  });

  it('400s when the product is eligible but inactive', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ id: PRODUCT_ID, isActive: false, selfServeEligible: true });
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
  });

  it('409s when the client already exists', async () => {
    mockState.createClientForSelfServe.mockResolvedValueOnce({ ok: false, error: 'client_already_exists' });
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(409);
  });

  it('creates the account with a hashed password and mints+sends a real verification token', async () => {
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest(VALID_BODY));
    const body = await res.clone().json();

    expect(res.status).toBe(201);
    expect(body.clientId).toBe('client_1');
    expect(mockState.hashPassword).toHaveBeenCalledWith('super-secret-8');
    expect(mockState.createClientForSelfServe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'aurora@example.com', passwordHash: 'argon2id$hashed' }),
    );
    expect(mockState.mintEmailVerificationToken).toHaveBeenCalledWith(expect.anything(), 'aurora@example.com');
    expect(mockState.sendVerifyEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'aurora@example.com', verifyUrl: expect.stringContaining(`token=${'a'.repeat(64)}`) }),
    );
  });

  it('still returns 201 when the verification email fails to send', async () => {
    mockState.sendVerifyEmail.mockRejectedValueOnce(new Error('resend_down'));
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(201);
    expect(mockState.logError).toHaveBeenCalled();
  });
});
