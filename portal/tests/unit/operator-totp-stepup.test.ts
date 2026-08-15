// =============================================================================
// Unit tests for requireTotpStepUp() — the gate for the two most sensitive
// admin actions (saving/rotating a Stripe key, confirming a price change).
// Confirms it is stricter than authenticateAdminRequest(): no cookie → 401,
// valid session without a fresh TOTP verification → 403, and explicitly
// that the legacy x-kaia-operator-key bypass never satisfies this gate
// (it has no OperatorSession row to prove step-up against).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionCookieId = vi.fn();
const getValidSession = vi.fn();

vi.mock('@/lib/operator-session', () => ({
  getSessionCookieId: (...args: unknown[]) => getSessionCookieId(...args),
  getValidSession: (...args: unknown[]) => getValidSession(...args),
  isTotpStillVerified: (totpVerifiedAt: Date | null) => {
    if (!totpVerifiedAt) return false;
    return Date.now() - totpVerifiedAt.getTime() < 5 * 60 * 1000;
  },
}));

function makeRequest(headers: Record<string, string> = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
  } as unknown as Parameters<typeof import('@/lib/operator-totp-stepup').requireTotpStepUp>[0];
}

describe('requireTotpStepUp', () => {
  beforeEach(() => {
    getSessionCookieId.mockReset();
    getValidSession.mockReset();
  });

  it('401s when there is no session cookie at all', async () => {
    getSessionCookieId.mockReturnValueOnce(null);
    const { requireTotpStepUp } = await import('@/lib/operator-totp-stepup');
    const result = await requireTotpStepUp(makeRequest());
    expect(result).toEqual({ ok: false, status: 401, error: 'unauthorized' });
    expect(getValidSession).not.toHaveBeenCalled();
  });

  it('401s when the cookie does not resolve to a valid session', async () => {
    getSessionCookieId.mockReturnValueOnce('sess_1');
    getValidSession.mockResolvedValueOnce(null);
    const { requireTotpStepUp } = await import('@/lib/operator-totp-stepup');
    const result = await requireTotpStepUp(makeRequest());
    expect(result).toEqual({ ok: false, status: 401, error: 'unauthorized' });
  });

  it('403s a valid session that never verified TOTP', async () => {
    getSessionCookieId.mockReturnValueOnce('sess_1');
    getValidSession.mockResolvedValueOnce({ operatorId: 'op_1', totpVerifiedAt: null });
    const { requireTotpStepUp } = await import('@/lib/operator-totp-stepup');
    const result = await requireTotpStepUp(makeRequest());
    expect(result).toEqual({ ok: false, status: 403, error: 'totp_step_up_required' });
  });

  it('403s a valid session whose TOTP verification is stale (outside the 5 min TTL)', async () => {
    getSessionCookieId.mockReturnValueOnce('sess_1');
    getValidSession.mockResolvedValueOnce({
      operatorId: 'op_1',
      totpVerifiedAt: new Date(Date.now() - 6 * 60 * 1000),
    });
    const { requireTotpStepUp } = await import('@/lib/operator-totp-stepup');
    const result = await requireTotpStepUp(makeRequest());
    expect(result).toEqual({ ok: false, status: 403, error: 'totp_step_up_required' });
  });

  it('succeeds for a valid session with a fresh TOTP verification', async () => {
    getSessionCookieId.mockReturnValueOnce('sess_1');
    getValidSession.mockResolvedValueOnce({
      operatorId: 'op_1',
      totpVerifiedAt: new Date(Date.now() - 60 * 1000),
    });
    const { requireTotpStepUp } = await import('@/lib/operator-totp-stepup');
    const result = await requireTotpStepUp(makeRequest());
    expect(result).toEqual({ ok: true, operatorId: 'op_1', sessionId: 'sess_1' });
  });

  it('a request carrying only the legacy x-kaia-operator-key header (no cookie) still 401s', async () => {
    // Regression pin: requireTotpStepUp() must never consult the legacy
    // header — only getSessionCookieId/getValidSession, which have no
    // OperatorSession to hang totpVerifiedAt off of for that bypass.
    getSessionCookieId.mockReturnValueOnce(null);
    process.env.KAIA_OPERATOR_API_KEY = 'shared-secret';
    const { requireTotpStepUp } = await import('@/lib/operator-totp-stepup');
    const result = await requireTotpStepUp(makeRequest({ 'x-kaia-operator-key': 'shared-secret' }));
    expect(result).toEqual({ ok: false, status: 401, error: 'unauthorized' });
    delete process.env.KAIA_OPERATOR_API_KEY;
  });
});
