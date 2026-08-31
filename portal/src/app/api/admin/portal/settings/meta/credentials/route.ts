import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { getMetaCredentialStatus, saveMetaCredential } from '@/lib/meta-credentials';
import { graphUrl } from '@/lib/meta-business';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const status = await getMetaCredentialStatus();
  return NextResponse.json(status);
}

const BodySchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
});

/**
 * POST /api/admin/portal/settings/meta/credentials
 *
 * Saves (or rotates) the operator's Meta app id/secret pair. Requires a
 * fresh TOTP step-up — this pair can act as the Meta app across every
 * connected client's WhatsApp/Messenger/Instagram, same blast-radius
 * class as Twilio's account credential pair. Verified against Meta (a
 * real, free App Access Token request — no message sent, no cost) before
 * it's persisted, same posture as the Twilio credential route, so an
 * operator finds out immediately if they pasted the wrong thing rather
 * than discovering it on the first client's signup attempt.
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
  const { appId, appSecret } = body.data;

  try {
    const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: 'client_credentials' });
    const res = await fetch(`${graphUrl('/oauth/access_token')}?${params.toString()}`);
    if (!res.ok) return NextResponse.json({ error: 'invalid_meta_credentials' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'invalid_meta_credentials' }, { status: 400 });
  }

  // Everything past this point (encrypting and persisting) is NOT
  // wrapped by the try/catch above — that one is scoped to 'did Meta
  // reject the credentials', a distinct failure. A misconfigured
  // encryption key throws synchronously and, unguarded, would crash this
  // route as an unhandled exception — see the Twilio/Stripe credentials
  // routes' identical comment for why that reads worse to an operator
  // than a clear internal_error.
  try {
    const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });
    await saveMetaCredential(appId, appSecret, {
      operatorId: stepUp.operatorId,
      operatorEmail: operator?.email ?? null,
    });
  } catch (err) {
    logError('meta_credentials.save_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, appId, lastFour: appSecret.slice(-4) });
}
