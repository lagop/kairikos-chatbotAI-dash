import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { saveTwilioRegulatoryIds } from '@/lib/twilio-credentials';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  bundleSid: z.string().min(1),
  addressSid: z.string().min(1),
});

/**
 * POST /api/admin/portal/settings/twilio/regulatory-ids
 *
 * Saves the Spanish numbering regulatory bundle/address SIDs. Deliberately
 * lighter than the account credential route: neither value is secret, so
 * no TOTP step-up and no verify-against-Twilio round trip — see
 * saveTwilioRegulatoryIds's header for the full reasoning. Still requires
 * a real admin session; this is a settings mutation, just not one of the
 * two gated behind step-up.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }
  const { bundleSid, addressSid } = body.data;

  const { operatorId } = auth;
  try {
    const operator = await prisma.operator.findUnique({ where: { id: operatorId }, select: { email: true } });
    await saveTwilioRegulatoryIds(bundleSid, addressSid, {
      operatorId,
      operatorEmail: operator?.email ?? null,
    });
  } catch (err) {
    logError('twilio_credentials.save_regulatory_ids_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, bundleSid, addressSid });
}
