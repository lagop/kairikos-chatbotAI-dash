import { NextResponse } from 'next/server';
import { constantTimeEqual } from './operator-crypto';
import 'server-only';

// =============================================================================
// KAIA-3129 — activity-key auth helper for the internal state-transition route.
//
// The shared secret that gates `POST /api/internal/clients/[id]/state-transition`
// is distinct from `PORTAL_API_KEY` (which gates the n8n → portal activity + lookup
// routes). The blast-radius lens says these two trust boundaries should not share
// a credential: a leak of `PORTAL_API_KEY` must not give an attacker the ability
// to flip `ChatbotClient.state`, and a leak of `KAIRIKOS_INTERNAL_ACTIVITY_KEY`
// must not give an attacker write access to the n8n milestone feeds.
//
// Auth scheme (mirrors `src/lib/internal-auth.ts`):
//   * Env:   `KAIRIKOS_INTERNAL_ACTIVITY_KEY` (Vercel project env; set by operator
//            per [KAIA-3126](/KAIA/issues/KAIA-3126)).
//   * Header: `X-Internal-Activity-Key` (single, well-known name — not a list).
//   * Comparison: `crypto.timingSafeEqual` against the expected value, with a
//                 constant-time fallback for length mismatch so the byte loop
//                 always runs against a same-length buffer.
//
// Failure modes:
//   401 — `missing_or_invalid_key` (bad or missing header).
//   500 — `server_misconfigured` (env var unset).
//
// The route caller maps the 500 path to a deploy-time bug surface so it shows up
// in monitoring rather than being conflated with client errors.
// =============================================================================

const ENV_KEY = 'KAIRIKOS_INTERNAL_ACTIVITY_KEY';
const HEADER_KEY = 'x-internal-activity-key';

export interface ActivityKeyAuthResult {
  ok: boolean;
  reason?: 'missing_key_header' | 'server_misconfigured' | 'invalid_key';
}

export function authenticateActivityKeyRequest(req: Request): ActivityKeyAuthResult {
  const expected = process.env[ENV_KEY];
  if (!expected) {
    return { ok: false, reason: 'server_misconfigured' };
  }

  const provided = req.headers.get(HEADER_KEY);
  if (!provided) {
    return { ok: false, reason: 'missing_key_header' };
  }

  return constantTimeEqual(provided, expected)
    ? { ok: true }
    : { ok: false, reason: 'invalid_key' };
}

/**
 * Reusable response helper. Returns a JSON Response with the canonical error
 * shape `{ error }` (no detail field — the issue spec deliberately does not
 * distinguish between missing and invalid so an attacker cannot probe the
 * header name vs the value path).
 *
 *   401 — `missing_or_invalid_key` (the canonical error per [KAIA-3129](/KAIA/issues/KAIA-3129)).
 *   500 — `missing_or_invalid_key` is NOT used here; `server_misconfigured`
 *         returns `{ error: 'server_misconfigured' }` so a deploy-time bug is
 *         obvious in monitoring.
 *
 * Returns null when the caller may proceed.
 */
export function activityKeyAuthFailureResponse(
  result: ActivityKeyAuthResult,
): NextResponse | null {
  if (result.ok) return null;

  if (result.reason === 'server_misconfigured') {
    return NextResponse.json(
      { error: 'server_misconfigured' },
      { status: 500 },
    );
  }
  return NextResponse.json(
    { error: 'missing_or_invalid_key' },
    { status: 401 },
  );
}
