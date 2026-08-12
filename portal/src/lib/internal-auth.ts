import { NextResponse } from 'next/server';
import { constantTimeEqual } from './operator-crypto';
import 'server-only';

const ENV_KEY = 'PORTAL_API_KEY';
const HEADER_KEYS = ['x-kairikos-internal-key', 'x-portal-api-key'] as const;

export interface InternalAuthResult {
  ok: boolean;
  reason?: 'missing_key_header' | 'server_misconfigured' | 'invalid_key';
}

/**
 * Verifies the caller is the n8n internal service (or any other trusted
 * server-side producer) for the /api/internal/* routes.
 *
 * Auth scheme: shared secret in `PORTAL_API_KEY` (Vercel / secret store),
 * compared with `crypto.timingSafeEqual` against the request header value.
 *
 * Why a shared secret (not NextAuth + RBAC):
 *   * n8n cannot do NextAuth (no browser, no email magic-link round-trip).
 *   * The endpoint is internal-only; the secret never leaves the trusted
 *     boundary (Vercel + n8n credential vault).
 *   * The route is the ONLY way to mutate `ChatbotActivity` from outside
 *     the portal's own session scope, so the secret gates every write.
 *
 * If `PORTAL_API_KEY` is unset the route refuses to start — fail closed
 * rather than allow unauthenticated writes.
 */
export function authenticateInternalRequest(req: Request): InternalAuthResult {
  const expected = process.env[ENV_KEY];
  if (!expected) {
    return { ok: false, reason: 'server_misconfigured' };
  }

  const provided = pickHeader(req, HEADER_KEYS);
  if (!provided) {
    return { ok: false, reason: 'missing_key_header' };
  }

  return constantTimeEqual(provided, expected)
    ? { ok: true }
    : { ok: false, reason: 'invalid_key' };
}

/**
 * Reusable response helper for the /api/internal/* family. Returns a JSON
 * Response with the canonical error shape (`{ error, detail }`) and the
 * correct status code for the auth outcome.
 *
 *   401 — `unauthorized` (bad or missing key). The n8n side reads `error`
 *         to decide whether to alert on a key-rotation issue.
 *   500 — `server_misconfigured` (PORTAL_API_KEY env var missing). This
 *         is a deploy-time bug, not a client error, so it surfaces as 500
 *         to make it obvious in monitoring.
 *
 * Returning null signals the caller may proceed with the request.
 */
export function internalAuthFailureResponse(
  result: InternalAuthResult,
): NextResponse | null {
  if (result.ok) return null;

  if (result.reason === 'server_misconfigured') {
    return NextResponse.json(
      { error: 'server_misconfigured', detail: 'PORTAL_API_KEY is not set' },
      { status: 500 },
    );
  }
  return NextResponse.json(
    { error: 'unauthorized', detail: result.reason ?? 'invalid_key' },
    { status: 401 },
  );
}

function pickHeader(req: Request, names: readonly string[]): string | null {
  for (const name of names) {
    const v = req.headers.get(name);
    if (v) return v;
  }
  return null;
}
