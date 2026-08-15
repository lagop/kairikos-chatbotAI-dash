import { NextResponse, type NextRequest } from 'next/server';
import Stripe from 'stripe';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { requireTotpStepUp } from '@/lib/operator-totp-stepup';
import { getStripeApiVersion } from '@/lib/stripe';
import { getStripeCredentialStatus, saveStripeCredential, type StripeMode } from '@/lib/stripe-credentials';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const status = await getStripeCredentialStatus();
  return NextResponse.json(status);
}

const BodySchema = z.object({
  mode: z.enum(['test', 'live']),
  secretKey: z.string().min(1),
});

const MODE_PREFIX: Record<StripeMode, string> = {
  test: 'sk_test_',
  live: 'sk_live_',
};

/**
 * POST /api/admin/portal/settings/stripe/credentials
 *
 * Saves (or rotates) the operator's Stripe secret key for one mode.
 * Requires a fresh TOTP step-up — this key can create real billing
 * objects. The key is verified against Stripe (a real API call) before
 * it's persisted, so an operator finds out immediately if they pasted
 * the wrong thing rather than discovering it on the first bootstrap.
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
  const { mode, secretKey } = body.data;

  if (!secretKey.startsWith(MODE_PREFIX[mode])) {
    return NextResponse.json({ error: 'invalid_stripe_key', detail: `expected_prefix:${MODE_PREFIX[mode]}` }, { status: 400 });
  }

  try {
    const probe = new Stripe(secretKey, { apiVersion: getStripeApiVersion() as Stripe.LatestApiVersion, typescript: true });
    await probe.balance.retrieve();
  } catch {
    return NextResponse.json({ error: 'invalid_stripe_key' }, { status: 400 });
  }

  const operator = await prisma.operator.findUnique({ where: { id: stepUp.operatorId }, select: { email: true } });

  await saveStripeCredential(mode, secretKey, { operatorId: stepUp.operatorId, operatorEmail: operator?.email ?? null });

  return NextResponse.json({ ok: true, mode, lastFour: secretKey.slice(-4) });
}
