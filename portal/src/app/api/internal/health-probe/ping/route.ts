import { NextResponse, type NextRequest } from 'next/server';
import {
  authenticateInternalRequest,
  internalAuthFailureResponse,
} from '@/lib/internal-auth';

// =============================================================================
// GET /api/internal/health-probe/ping
//
// KAIA-1110 — minimal endpoint hit by the `portal_api_key` health probe.
// The probe is asking "does this key still authenticate?"; we only need
// to confirm the auth header round-trips successfully. No DB access, no
// side effects — so this route is safe to be called every 5 minutes by
// the worker without putting load on Postgres.
//
// Auth: shared secret in PORTAL_API_KEY, identical to the rest of the
// /api/internal/* family. The probe passes the key in
// `x-kairikos-internal-key`; the helper also accepts `x-portal-api-key`
// for parity with the other internal routes.
//
// Response:
//   200 — { ok: true }  (key is valid; this is the "healthy" signal)
//   401 — handled by `internalAuthFailureResponse`
//   500 — handled by `internalAuthFailureResponse` when PORTAL_API_KEY
//         is unset on the server
// =============================================================================

export async function GET(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  return NextResponse.json({ ok: true });
}

export function POST() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
