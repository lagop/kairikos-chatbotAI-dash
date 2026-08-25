import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { blockNumber, unblockNumber, listBlockedNumbers } from '@/lib/recall-blocklist';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  number: z.string().min(6).max(32),
  reason: z.string().max(200).optional(),
});

const DeleteSchema = z.object({ number: z.string().min(6).max(32) });

interface Params {
  params: { subscriptionId: string };
}

/**
 * GET/POST/DELETE /api/admin/portal/recall/[subscriptionId]/blocklist
 *
 * The operator's control over which numbers this client's WhatsApp will
 * never answer. Operator-only: the client asks, the operator acts — same
 * posture as the rest of this product, where the portal is the operator's
 * tool and the client lives in WhatsApp.
 *
 * The number is normalised to E.164 on the way in. That is not cosmetic:
 * Twilio sends '+34651234567' and an operator types '651 23 45 67', so a
 * list that stored what was typed would look right in the panel and match
 * nothing at all.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const numbers = await listBlockedNumbers(prisma, params.subscriptionId);
  return NextResponse.json({ ok: true, numbers });
}

export async function POST(req: NextRequest, { params }: Params) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const result = await blockNumber(prisma, params.subscriptionId, body.data.number, {
    reason: body.data.reason ?? null,
    // operatorId, not an email: the auth result carries the id and the
    // audit trail elsewhere in this product resolves ids to people.
    createdBy: auth.operatorId,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.error === 'subscription_not_found' ? 404 : 400 },
    );
  }
  return NextResponse.json({ ok: true, id: result.id, e164: result.e164 });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = DeleteSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const removed = await unblockNumber(prisma, params.subscriptionId, body.data.number);
  if (!removed) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
