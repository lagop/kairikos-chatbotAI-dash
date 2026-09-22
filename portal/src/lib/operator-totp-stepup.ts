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
 * Solo con una OperatorSession: la cabecera x-kaia-operator-key, que nunca
 * valió aquí, se retiró del todo el 22/09/2026.
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
