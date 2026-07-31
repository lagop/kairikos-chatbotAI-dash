import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { SignupSchema } from '@/lib/onboarding/schemas';
import { startOnboardingSession } from '@/lib/onboarding/sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/onboarding/start — KAIA-4263
//
// Public, idempotent. Body: { email, source?, idempotencyKey? }.
//
// Behaviour:
//   1. Validate the email + source with the SignupSchema.
//   2. Resolve a session token + tenant slug via
//      `startOnboardingSession`.
//      - The DB-unique idempotency_key (defaults to SHA-256(email))
//        guarantees retries never create a second tenant.
//      - When DATABASE_URL is unset (preview environment) the helper
//        returns a synthetic token + slug so the wizard can be demoed.
//   3. Forward the canonical sessionToken + tenantSlug to the React
//      wizard (it stores both in localStorage keyed by `kairikos.onboarding.v1`).
//
// Open follow-up:
//   The Backend Developer will own the canonical creation flow once
//   the Tenant / Profile / User models settle (cross-reference
//   KAIA-4258). Until that lands this route persists to the local
//   `OnboardingSession` table; once it does, the migration runs in
//   place and the route delegates to the canonical endpoint without
//   a wizard contract change.
//
// Responses:
//   200 { sessionId, tenantSlug, duplicate }
//   400 { error: 'invalid_body', details }
//   500 { error: 'service_unavailable', detail }
// =============================================================================
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const idempotencyKey =
    parsed.data.idempotencyKey ??
    req.headers.get('x-idempotency-key')?.trim() ??
    randomUUID();

  try {
    const result = await startOnboardingSession({
      email: parsed.data.email,
      source: parsed.data.source,
      idempotencyKey,
    });
    return NextResponse.json(
      {
        sessionId: result.sessionToken,
        tenantSlug: result.tenantSlug,
        duplicate: result.duplicate,
      },
      { status: 200 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: 'service_unavailable',
        detail: err instanceof Error ? err.message : 'unknown',
      },
      { status: 500 },
    );
  }
}
