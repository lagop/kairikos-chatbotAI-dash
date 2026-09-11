// =============================================================================
// POST /api/admin/portal/clients/[id]/send-setup-email
//
// KAIA-13282 — this route never had coverage, which is exactly how a
// token-less setup link (rejected client-side as "El enlace no es
// válido") shipped and stayed broken: nothing asserted the URL it
// builds actually contains a valid token.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  authenticateAdminRequest: vi.fn(),
  findFirstClientUser: vi.fn(),
  findUniqueUser: vi.fn(),
  mintSetupPasswordToken: vi.fn(),
  sendSetupPassword: vi.fn(),
}));

vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: (...args: unknown[]) => mockState.authenticateAdminRequest(...args),
}));

vi.mock('@/lib/admin-client-onboarding', () => ({
  mintSetupPasswordToken: (...args: unknown[]) => mockState.mintSetupPasswordToken(...args),
}));

vi.mock('@/lib/auth-email', () => ({
  sendSetupPassword: (...args: unknown[]) => mockState.sendSetupPassword(...args),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatbotClientUser: { findFirst: (...args: unknown[]) => mockState.findFirstClientUser(...args) },
    user: { findUnique: (...args: unknown[]) => mockState.findUniqueUser(...args) },
  },
  isDatabaseConfigured: true,
}));

function makeRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<
    typeof import('@/app/api/admin/portal/clients/[id]/send-setup-email/route').POST
  >[0];
}

const PARAMS = { params: { id: 'client_1' } };

beforeEach(() => {
  mockState.authenticateAdminRequest.mockReset().mockResolvedValue({ ok: true, operatorId: 'op_1' });
  mockState.findFirstClientUser.mockReset().mockResolvedValue({ id: 'cu_1', userId: 'u_1' });
  mockState.findUniqueUser.mockReset().mockResolvedValue({ id: 'u_1', passwordHash: null });
  mockState.mintSetupPasswordToken.mockReset().mockResolvedValue('a'.repeat(64));
  mockState.sendSetupPassword.mockReset().mockResolvedValue(undefined);
});

describe('POST /api/admin/portal/clients/[id]/send-setup-email', () => {
  it('403s when the caller is not an authenticated operator', async () => {
    mockState.authenticateAdminRequest.mockResolvedValueOnce({ ok: false });
    const { POST } = await import('@/app/api/admin/portal/clients/[id]/send-setup-email/route');
    const res = await POST(makeRequest({ email: 'a@b.com' }), PARAMS);
    expect(res.status).toBe(403);
  });

  it('404s when the client user does not exist', async () => {
    mockState.findFirstClientUser.mockResolvedValueOnce(null);
    const { POST } = await import('@/app/api/admin/portal/clients/[id]/send-setup-email/route');
    const res = await POST(makeRequest({ email: 'a@b.com' }), PARAMS);
    expect(res.status).toBe(404);
  });

  it('409s when the user already has a password set', async () => {
    mockState.findUniqueUser.mockResolvedValueOnce({ id: 'u_1', passwordHash: 'already-hashed' });
    const { POST } = await import('@/app/api/admin/portal/clients/[id]/send-setup-email/route');
    const res = await POST(makeRequest({ email: 'a@b.com' }), PARAMS);
    expect(res.status).toBe(409);
    expect(mockState.mintSetupPasswordToken).not.toHaveBeenCalled();
  });

  it('mints a real token and embeds it in the setup URL that gets emailed', async () => {
    const { POST } = await import('@/app/api/admin/portal/clients/[id]/send-setup-email/route');
    const res = await POST(makeRequest({ email: 'a@b.com' }), PARAMS);

    expect(res.status).toBe(200);
    expect(mockState.mintSetupPasswordToken).toHaveBeenCalledWith(expect.anything(), 'a@b.com');
    expect(mockState.sendSetupPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'a@b.com',
        setupUrl: expect.stringMatching(new RegExp(`token=${'a'.repeat(64)}`)),
      }),
    );
  });

  it('500s when the email fails to send', async () => {
    mockState.sendSetupPassword.mockRejectedValueOnce(new Error('resend_down'));
    const { POST } = await import('@/app/api/admin/portal/clients/[id]/send-setup-email/route');
    const res = await POST(makeRequest({ email: 'a@b.com' }), PARAMS);
    expect(res.status).toBe(500);
  });
});
