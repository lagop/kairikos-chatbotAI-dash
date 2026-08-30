import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { getTwilioCredentialStatus, saveTwilioCredential } from '@/lib/twilio-credentials';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const status = await getTwilioCredentialStatus();
  return NextResponse.json(status);
}

const BodySchema = z.object({
  accountSid: z.string().min(1),
  authToken: z.string().min(1),
});

/**
 * POST /api/admin/portal/settings/twilio/credentials
 *
 * Saves (or rotates) the operator's Twilio credential pair. Requires a
 * fresh TOTP step-up — this pair can place real calls and send real SMS
 * (and, once saved, is also what every inbound Twilio webhook's
 * signature is checked against). The pair is verified against Twilio (a
 * real API call) before it's persisted, same posture as the Stripe
 * credential route, so an operator finds out immediately if they pasted
 * the wrong thing rather than discovering it on the first provisioning
 * attempt.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }
  const { accountSid, authToken } = body.data;

  if (!accountSid.startsWith('AC')) {
    return NextResponse.json({ error: 'invalid_twilio_credentials', detail: 'expected_prefix:AC' }, { status: 400 });
  }

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
    });
    if (!res.ok) return NextResponse.json({ error: 'invalid_twilio_credentials' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'invalid_twilio_credentials' }, { status: 400 });
  }

  // Everything past this point (encrypting and persisting) is NOT
  // wrapped by the try/catch above — that one is scoped to 'did Twilio
  // reject the credentials', a distinct failure. A misconfigured
  // encryption key throws synchronously and, unguarded, would crash this
  // route as an unhandled exception — see the Stripe credentials route's
  // identical comment for why that reads worse to an operator than a
  // clear internal_error.
  try {
    const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });
    await saveTwilioCredential(accountSid, authToken, {
      operatorId: stepUp.operatorId,
      operatorEmail: operator?.email ?? null,
    });
  } catch (err) {
    logError('twilio_credentials.save_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, accountSid, lastFour: authToken.slice(-4) });
}
