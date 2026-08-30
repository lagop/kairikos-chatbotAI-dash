import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { assignNumberToSubscription } from '@/lib/recall-numbers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  subscriptionId: z.string().uuid(),
  countryCode: z.string().length(2).optional(),
});

const ERROR_STATUS: Record<string, number> = {
  subscription_not_found: 404,
  // Legal request, wrong moment — the subscription hasn't reached
  // meta_connected yet, or it's cancelled. See canBindVirtualNumber().
  invalid_status: 409,
  already_assigned: 409,
  // Not the operator's fault and not a bad request: the pool is empty and
  // someone needs to buy more. 503 so it reads as "temporarily can't",
  // which is exactly what it is.
  pool_empty: 503,
};

/**
 * POST /api/admin/portal/recall/numbers/assign
 *
 * Claim a number from the pool for one subscription. No provider call —
 * that is the whole point of the pool, and why this responds in
 * milliseconds instead of waiting on Twilio while the operator has the
 * client on the phone.
 *
 * Writes an audit row on success. The binding is the interesting event
 * for anyone reconstructing "what did this account look like when the
 * client said it stopped working", so it goes in the trail alongside the
 * status transitions.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const result = await assignNumberToSubscription(prisma, body.data.subscriptionId, {
    countryCode: body.data.countryCode,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] ?? 400 });
  }

  const subscription = await prisma.recallSubscription.findUnique({
    where: { id: body.data.subscriptionId },
    select: { clientId: true, status: true },
  });
  if (subscription) {
    await prisma.recallSubscriptionAudit
      .create({
        data: {
          subscriptionId: body.data.subscriptionId,
          clientId: subscription.clientId,
          action: 'number_assigned',
          after: { virtualNumberId: result.numberId, e164: result.e164, status: subscription.status },
          actorType: 'operator',
          actorOperatorId: auth.operatorId,
        },
      })
      // The number IS assigned at this point; failing the whole request
      // because the audit insert failed would leave the operator retrying
      // an action that already succeeded.
      .catch(() => null);
  }

  return NextResponse.json({ ok: true, numberId: result.numberId, e164: result.e164, advancedTo: result.advancedTo });
}
