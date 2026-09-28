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
  sendAccountExistsEmail: vi.fn(),
  findUniqueUser: vi.fn(),
  logError: vi.fn(),
  attributeClient: vi.fn(),
}));

vi.mock('@/lib/referrals', () => ({
  attributeClient: (...args: unknown[]) => mockState.attributeClient(...args),
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
  sendAccountExistsEmail: (...args: unknown[]) => mockState.sendAccountExistsEmail(...args),
}));

vi.mock('@/lib/observability', () => ({ logError: (...args: unknown[]) => mockState.logError(...args) }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    product: { findUnique: (...args: unknown[]) => mockState.findUniqueProduct(...args) },
    user: { findUnique: (...args: unknown[]) => mockState.findUniqueUser(...args) },
  },
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
  mockState.sendAccountExistsEmail.mockReset().mockResolvedValue(undefined);
  mockState.findUniqueUser.mockReset().mockResolvedValue(null);
  mockState.logError.mockReset();
  mockState.attributeClient.mockReset().mockResolvedValue({ ok: true, codeId: 'code_1' });
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
    expect(res.status).toBe(202);
    expect(mockState.createClientForSelfServe).toHaveBeenCalled();
    // El enlace de verificación le dice a la página que siga por presupuesto.
    expect(mockState.sendVerifyEmail).toHaveBeenCalledWith(
      expect.objectContaining({ verifyUrl: expect.stringContaining(`product=${PRODUCT_ID}&quote=1`) }),
    );
  });

  it('400s when the product is eligible but inactive', async () => {
    mockState.findUniqueProduct.mockResolvedValueOnce({ id: PRODUCT_ID, isActive: false, selfServeEligible: true });
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(400);
  });

  // Revisión de seguridad 22/09/2026 — el 409 decía a cualquiera si un
  // email era cliente. Ahora la respuesta es idéntica y el aviso va al buzón.
  it('answers exactly like a new signup when the client already exists, and emails the real owner instead', async () => {
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const fresh = await POST(makeRequest(VALID_BODY));
    mockState.createClientForSelfServe.mockResolvedValueOnce({ ok: false, error: 'client_already_exists' });
    mockState.sendVerifyEmail.mockClear();
    const existing = await POST(makeRequest(VALID_BODY));

    expect(existing.status).toBe(fresh.status);
    expect(await existing.json()).toEqual(await fresh.json());
    expect(mockState.sendAccountExistsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'aurora@example.com', forgotUrl: expect.stringContaining('/portal/forgot-password') }),
    );
    // Nunca se reenvía el enlace de activación a una cuenta ya existente: si
    // sigue pendiente, activaría la contraseña de quien la creó.
    expect(mockState.sendVerifyEmail).not.toHaveBeenCalled();
  });

  it('treats an email that is already a login (of any client) as existing — no 500 from a duplicate User', async () => {
    mockState.findUniqueUser.mockResolvedValueOnce({ id: 'user_other' });
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(202);
    expect(mockState.createClientForSelfServe).not.toHaveBeenCalled();
    expect(mockState.sendAccountExistsEmail).toHaveBeenCalled();
  });

  it('creates the account with a hashed password and mints+sends a real verification token', async () => {
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest(VALID_BODY));
    const body = await res.clone().json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ ok: true, verificationSent: true });
    expect(mockState.hashPassword).toHaveBeenCalledWith('super-secret-8');
    expect(mockState.createClientForSelfServe).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: 'aurora@example.com', passwordHash: 'argon2id$hashed' }),
    );
    expect(mockState.mintEmailVerificationToken).toHaveBeenCalledWith(expect.anything(), 'aurora@example.com');
    expect(mockState.sendVerifyEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'aurora@example.com', verifyUrl: expect.stringContaining(`token=${'a'.repeat(64)}`) }),
    );
    const { verifyUrl } = mockState.sendVerifyEmail.mock.calls[0][0];
    expect(verifyUrl).toContain(`product=${PRODUCT_ID}`);
    expect(verifyUrl).not.toContain('quote=1');
  });

  // ===========================================================================
  // A7 — el alta es el único sitio donde se puede preguntar quién lo trajo.
  // Lo que se fija: que se apunte, y que NUNCA pueda tumbar el alta. Un
  // código mal tecleado cuesta una comisión; un alta perdida, un cliente.
  // ===========================================================================
  it('apunta de quién vino el cliente cuando llega con un código', async () => {
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest({ ...VALID_BODY, codigo: ' saltoki-adef2 ' }));
    expect(res.status).toBe(202);
    expect(mockState.attributeClient).toHaveBeenCalledWith(expect.anything(), 'client_1', 'saltoki-adef2');
  });

  it('sin código no se toca la atribución', async () => {
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    await POST(makeRequest(VALID_BODY));
    expect(mockState.attributeClient).not.toHaveBeenCalled();
  });

  it('un código que no existe no impide el alta', async () => {
    mockState.attributeClient.mockResolvedValueOnce({ ok: false, reason: 'unknown_code' });
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest({ ...VALID_BODY, codigo: 'NOEXISTE' }));
    expect(res.status).toBe(202);
    expect(mockState.sendVerifyEmail).toHaveBeenCalled();
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('si la atribución revienta, el alta sigue adelante igual', async () => {
    mockState.attributeClient.mockRejectedValueOnce(new Error('db_down'));
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest({ ...VALID_BODY, codigo: 'SALTOKI-ADEF2' }));
    expect(res.status).toBe(202);
    expect(mockState.sendVerifyEmail).toHaveBeenCalled();
  });

  it('a una cuenta que ya existía no se le atribuye nada: no hay cliente nuevo que atribuir', async () => {
    mockState.createClientForSelfServe.mockResolvedValueOnce({ ok: false, error: 'client_already_exists' });
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    await POST(makeRequest({ ...VALID_BODY, codigo: 'SALTOKI-ADEF2' }));
    expect(mockState.attributeClient).not.toHaveBeenCalled();
  });

  it('still returns 202 when the verification email fails to send', async () => {
    mockState.sendVerifyEmail.mockRejectedValueOnce(new Error('resend_down'));
    const { POST } = await import('@/app/api/public/self-serve-signup/route');
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(202);
    expect(mockState.logError).toHaveBeenCalled();
  });
});
