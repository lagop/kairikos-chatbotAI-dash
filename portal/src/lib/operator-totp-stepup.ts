import type { NextRequest } from 'next/server';
import { getSessionCookieId, getValidSession, isTotpStillVerified } from './operator-session';

export type StepUpResult =
  | { ok: true; operatorId: string; sessionId: string }
  | { ok: false; status: 401; error: 'unauthorized' }
  | { ok: false; status: 403; error: 'totp_step_up_required' };

/**
 * Gate for the two action classes sensitive enough to need a fresh TOTP
 * confirmation on top of a normal operator session: saving/rotating the
 * Stripe secret key, and confirming a price bootstrap/reprice. Both can
 * create real Stripe billing objects, so a stale or hijacked session
 * cookie alone isn't enough.
 *
 * Deliberately does NOT accept the legacy `x-kaia-operator-key` bypass
 * that authenticateAdminRequest() falls back to — that path has no real
 * OperatorSession row to hang totpVerifiedAt off of, so there is no way
 * to prove step-up happened. A caller on that path gets a clean 401
 * here, not a silent bypass of the two most sensitive actions in the
 * system.
 */
export async function requireTotpStepUp(req: NextRequest): Promise<StepUpResult> {
  const sessionId = getSessionCookieId(req);
  if (!sessionId) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  const session = await getValidSession(sessionId);
  if (!session) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  if (!isTotpStillVerified(session.totpVerifiedAt)) {
    return { ok: false, status: 403, error: 'totp_step_up_required' };
  }
  return { ok: true, operatorId: session.operatorId, sessionId };
}
