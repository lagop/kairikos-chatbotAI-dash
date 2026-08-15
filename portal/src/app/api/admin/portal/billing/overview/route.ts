import { NextResponse, type NextRequest } from 'next/server';
import { isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { getOwnerBillingOverview } from '@/lib/stripe-billing';
import { isStripeConfigured } from '@/lib/stripe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * KAIA-4262 — Owner billing overview API.
 *
 * Route shape:
 *   GET /api/admin/portal/billing/overview
 *
 * Returns the aggregated billing data the owner dashboard needs:
 *   * mrrByProductCents — keyed by Product.id (WP-12: tier is only unique
 *     within a product's code, so it can't key this map on its own),
 *     includes mrr + active count
 *   * mrrTotalCents — sum across all active subscriptions
 *   * expiringSoon — active subscriptions whose current_period_end is
 *     within the next 14 days
 *   * recentCancellations — subscriptions canceled in the last 30 days
 *
 * Responses:
 *   200 { …OwnerBillingOverview }
 *   401 { error: 'unauthorized' }
 *   503 { error: 'service_unavailable', detail: 'database_not_configured' | 'stripe_not_configured' }
 *
 * Auth: operator session (kairikos_operator_session cookie). The owner
 * is the only role with portal-wide visibility — clients must not see
 * other tenants' MRR.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'database_not_configured' }, { status: 503 });
  }
  if (!(await isStripeConfigured())) {
    return NextResponse.json({ error: 'service_unavailable', detail: 'stripe_not_configured' }, { status: 503 });
  }

  const overview = await getOwnerBillingOverview();
  return NextResponse.json(overview);
}
