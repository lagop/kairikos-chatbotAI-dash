import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import {
  getIntegrationCredentialStatus,
  saveIntegrationCredential,
} from '@/lib/integration-credentials';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TOOL_KEY = 'google_places';
const DISPLAY_NAME = 'Google Places';

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const status = await getIntegrationCredentialStatus(TOOL_KEY);
  return NextResponse.json(status);
}

const BodySchema = z.object({ apiKey: z.string().trim().min(10) });

/**
 * POST /api/admin/portal/settings/integrations/google-places
 *
 * Saves (or rotates) the operator's Google Places API key. No TOTP
 * step-up, unlike Stripe's credential route — this key is read-only
 * against Google's own account, not a payment credential; the worst case
 * of a leak is unwanted API spend, which prospecting.ts's own per-campaign
 * monthly cap already bounds.
 *
 * Deliberately does NOT verify the key against a real Places API call
 * before saving, unlike Stripe's `probe.balance.retrieve()` — every
 * Places call costs money (there is no free ping), so auto-verifying on
 * save would spend the operator's budget just for pasting a key. A wrong
 * key surfaces the normal way instead: prospecting-tick's own error
 * logging on the next scheduled search.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  try {
    // authenticateAdminRequest returns the placeholder id 'legacy' for the
    // KAIA_OPERATOR_API_KEY header path, which is not a real Operator row
    // — looking it up would throw (not a valid UUID). The audit's
    // actorOperatorId is nullable for exactly this case.
    const isLegacyAuth = auth.operatorId === 'legacy';
    const operator = isLegacyAuth
      ? null
      : await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
    await saveIntegrationCredential(TOOL_KEY, DISPLAY_NAME, body.data.apiKey, {
      operatorId: isLegacyAuth ? null : auth.operatorId,
      operatorEmail: operator?.email ?? null,
    });
  } catch (err) {
    logError('integration_credentials.save_failed', err, { toolKey: TOOL_KEY });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, lastFour: body.data.apiKey.slice(-4) });
}
