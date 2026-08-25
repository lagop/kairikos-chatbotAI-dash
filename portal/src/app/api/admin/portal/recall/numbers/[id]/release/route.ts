import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { getTelephonyProvider, isTelephonyConfigured } from '@/lib/telephony';
import { releaseNumber } from '@/lib/recall-numbers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ERROR_STATUS: Record<string, number> = {
  number_not_found: 404,
  already_released: 409,
  provider_failed: 502,
};

/**
 * POST /api/admin/portal/recall/numbers/[id]/release
 *
 * Hand a number back to the provider and stop paying for it.
 *
 * Not TOTP-gated: this is destructive but recoverable and not
 * money-moving in the way the WebQuote send/invoice actions are — the
 * worst case is buying a replacement. It IS audited, because releasing
 * the number of a live client silently breaks their service and someone
 * will need to know who did it.
 *
 * On provider failure the row keeps its status and records lastError
 * rather than being marked released — see recall-numbers.ts's header on
 * why the database stays the conservative side of that disagreement.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  if (!isTelephonyConfigured()) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'telephony_not_configured' }, { status: 503 });
  }

  // Read the binding BEFORE releasing: the release nulls subscriptionId,
  // and the audit row needs to say whose number this was.
  const before = await prisma.virtualNumber.findUnique({
    where: { id: params.id },
    select: { e164: true, subscriptionId: true, subscription: { select: { clientId: true } } },
  });

  const result = await releaseNumber(prisma, getTelephonyProvider(), params.id);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.detail ? { detail: result.detail } : {}) },
      { status: ERROR_STATUS[result.error] ?? 400 },
    );
  }

  if (before?.subscriptionId && before.subscription) {
    await prisma.recallSubscriptionAudit
      .create({
        data: {
          subscriptionId: before.subscriptionId,
          clientId: before.subscription.clientId,
          action: 'number_released',
          before: { virtualNumberId: params.id, e164: before.e164 },
          actorType: 'operator',
          actorOperatorId: auth.operatorId,
        },
      })
      .catch(() => null);
  }

  return NextResponse.json({ ok: true });
}
