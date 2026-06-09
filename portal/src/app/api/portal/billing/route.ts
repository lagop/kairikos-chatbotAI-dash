import { NextResponse, type NextRequest } from 'next/server';
import { isBackendConfigured, PORTAL_API_BASE_URL } from '@/lib/supabase';
import { authenticateRequest, isKnownClientId, isUuid } from '@/lib/api-auth';

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const requestedClientId = url.searchParams.get('client_id');
  if (requestedClientId) {
    if (!isUuid(requestedClientId)) {
      return NextResponse.json({ error: 'bad_request' }, { status: 400 });
    }
    if (requestedClientId === auth.clientId) {
      // fall through
    } else if (isKnownClientId(requestedClientId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    } else {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
  }
  if (isBackendConfigured) {
    const upstream = await fetch(`${PORTAL_API_BASE_URL}/portal/billing`, {
      headers: { Authorization: req.headers.get('authorization') ?? '' },
      cache: 'no-store',
    });
    return new NextResponse(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json' } });
  }
  return NextResponse.json({
    tier: 'pro',
    tierLabel: 'Web Pro',
    monthlyFeeCents: 24900,
    currency: 'EUR',
    nextInvoiceDate: '2026-07-01T00:00:00.000Z',
    nextInvoiceAmountCents: 24900,
    stripeCustomerPortalUrl: 'https://billing.stripe.com/p/session/cus_test_client_a',
    stripeCustomerId: 'cus_test_client_a',
  });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
