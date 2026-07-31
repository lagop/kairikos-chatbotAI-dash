import { NextResponse, type NextRequest } from 'next/server';
import { ConfigSchema } from '@/lib/onboarding/schemas';
import { getOnboardingSession, updateOnboardingSession } from '@/lib/onboarding/sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// POST /api/onboarding/config — KAIA-4263
//
// Saves the minimum-configuration payload captured at the wizard's
// /config step (businessName, sector, whatsapp, contactEmail).
// Body matches the ConfigSchema.
//
// Responses:
//   200 { ok: true }
//   400 { error: 'invalid_body', details }
//   404 { error: 'session_not_found' }
//   503 { error: 'service_unavailable', detail }
//
// Until the Backend Developer wires the canonical migration this
// endpoint persists directly to `OnboardingSession`. The schema is
// intentionally denormalized so the migration can later copy
// businessName + sector into the Tenant row without round-trips.
// =============================================================================
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const parsed = ConfigSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const session = await getOnboardingSession(parsed.data.sessionId);
  if (!session) {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }

  try {
    await updateOnboardingSession(parsed.data.sessionId, {
      businessName: parsed.data.businessName,
      sector: parsed.data.sector,
      whatsapp: parsed.data.whatsapp ?? null,
      contactEmail: parsed.data.contactEmail ?? null,
    });
    return NextResponse.json({ ok: true });
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
