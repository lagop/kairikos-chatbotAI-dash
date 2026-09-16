import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { isStripeConfigured } from '@/lib/stripe';
import { createSetupFeeWaiverCode, listSetupFeeWaiverCodes } from '@/lib/stripe-promotions';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// GET/POST /api/admin/portal/settings/promotions — códigos que anulan el alta
// de un tier. Ver lib/stripe-promotions.ts.
//
// Crear exige TOTP, igual que reprice: un código es dinero que se deja de
// cobrar, y crea objetos reales en Stripe.
// =============================================================================

const ERROR_STATUS: Record<string, number> = {
  product_not_found: 404,
  not_bootstrapped: 409,
  no_setup_fee: 409,
  invalid_code: 400,
  invalid_expiry: 400,
  code_already_exists: 409,
  stripe_error: 502,
};

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!(await isStripeConfigured())) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_not_configured' }, { status: 503 });
  }

  const listed = await listSetupFeeWaiverCodes();
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 502 });
  return NextResponse.json({ codes: listed.codes });
}

const BodySchema = z.object({
  productId: z.string().uuid(),
  code: z.string().min(1).max(60),
  // YYYY-MM-DD del <input type="date">; caduca al final de ese día (UTC).
  expiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  maxRedemptions: z.number().int().min(1).max(10_000).nullish(),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const stepUp = await requireTotpStepUp(req);
  if (!stepUp.ok) return NextResponse.json({ error: stepUp.error }, { status: stepUp.status });

  if (!(await isStripeConfigured())) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_not_configured' }, { status: 503 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });
  const actor = { operatorId: stepUp.operatorId, operatorEmail: operator?.email ?? null };

  let result;
  try {
    result = await createSetupFeeWaiverCode(
      {
        productId: body.data.productId,
        code: body.data.code,
        expiresAt: body.data.expiresOn ? new Date(`${body.data.expiresOn}T23:59:59Z`) : null,
        maxRedemptions: body.data.maxRedemptions ?? null,
      },
      actor,
    );
  } catch (err) {
    logError('stripe_promotions.create_route_failed', err, { productId: body.data.productId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error, detail: result.detail }, { status: ERROR_STATUS[result.error] ?? 500 });
  }
  return NextResponse.json({ ok: true, promotionCode: result.promotionCode }, { status: 201 });
}
