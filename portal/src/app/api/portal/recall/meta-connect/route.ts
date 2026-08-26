import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { isCoexistenceSignupConfigured } from '@/lib/meta-business';
import { connectRecallWhatsapp } from '@/lib/recall-meta';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 8 ('recall') — POST /api/portal/recall/meta-connect
//
// The coexistence sibling of /api/portal/channels/meta/complete-signup —
// see recall-meta.ts's header for why this is a separate route rather
// than a branch in that one. Gated on the 'recall' product, never on
// chatbot-tier channel entitlements: a recall-only client with no
// chatbot product has every right to connect their WhatsApp here.
// =============================================================================

const BodySchema = z.object({
  code: z.string().min(1, 'required'),
  wabaId: z.string().min(1, 'required'),
});

const ERROR_STATUS: Record<string, number> = {
  forbidden: 403,
  not_configured: 503,
  subscription_not_found: 404,
  invalid_status: 409,
  code_exchange_failed: 502,
  phone_number_not_found: 502,
  persist_failed: 500,
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  if (!isCoexistenceSignupConfigured()) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
  }

  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const hasRecall = await isProductContracted(prisma, resolved.clientId, 'recall');
  if (!hasRecall) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const subscription = await prisma.recallSubscription.findFirst({
    where: { clientId: resolved.clientId },
    select: { id: true, tenantId: true },
  });
  if (!subscription) {
    return NextResponse.json({ error: 'subscription_not_found' }, { status: 404 });
  }

  let result;
  try {
    result = await connectRecallWhatsapp(prisma, {
      clientId: resolved.clientId,
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      code: body.data.code,
      wabaId: body.data.wabaId,
    });
  } catch (err) {
    logError('recall_meta.connect_route_failed', err, { clientId: resolved.clientId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] ?? 400 });
  }

  return NextResponse.json({
    ok: true,
    displayPhoneNumber: result.displayPhoneNumber,
    advancedTo: result.advancedTo,
  });
}
