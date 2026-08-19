import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { getBillingForClient } from '@/lib/stripe-billing';
import { isStripeConfigured } from '@/lib/stripe';
import { MOCK_BILLING_EXPORT as MOCK_BILLING } from '@/lib/portal-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * KAIA-4262 — Client billing page API.
 *
 * Route shape:
 *   GET /api/portal/billing
 *
 * Returns the authenticated client's billing summary: Stripe customer
 * id, active subscriptions per product, upcoming invoice (sum of
 * active subscription periods), and the last 12 invoices with PDF +
 * hosted URLs.
 *
 * Responses:
 *   200 { …ClientBillingSummary }
 *   401 { error: 'unauthorized' }
 *   404 { error: 'not_found' }
 *   503 { error: 'service_unavailable' }
 *
 * In dev-mock mode (Supabase not configured, no DATABASE_URL, etc.)
 * the route returns the same MOCK_BILLING fixture the prior version
 * shipped so the demo UI is still demoable.
 */
export async function GET(_req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (resolved.source === 'mock_dev' && !isDatabaseConfigured) {
    return NextResponse.json(MOCK_BILLING);
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const summary = await getBillingForClient(resolved.clientId);
  if (!summary) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // When Stripe is not configured (e.g. staging env without secrets
  // provisioned), fall back to a tier-only summary derived from the
  // client's tier column so the UI still has data to render.
  if (!(await isStripeConfigured())) {
    const client = await prisma.chatbotClient.findUnique({
      where: { id: resolved.clientId },
      select: { tier: true, stripeCustomerId: true },
    });
    if (!client) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({
      ...summary,
      stripeNotConfigured: true,
      tier: client.tier,
    });
  }

  return NextResponse.json({ ...summary, stripeNotConfigured: false });
}
