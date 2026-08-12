import { NextResponse, type NextRequest } from 'next/server';
import { isBackendConfigured, PORTAL_API_BASE_URL } from '@/lib/supabase';
import { authenticateAdminRequest } from '@/lib/operator-session';

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (isBackendConfigured) {
    const upstream = await fetch(`${PORTAL_API_BASE_URL}/admin/portal/clients`, {
      headers: { Authorization: req.headers.get('authorization') ?? '' },
      cache: 'no-store',
    });
    return new NextResponse(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json' } });
  }
  return NextResponse.json([
    {
      id: '00000000-0000-0000-0000-000000000001',
      slug: 'acme-corp',
      companyName: 'Acme Corp',
      primaryContactEmail: 'qa-test-client-a@kairikos.com',
      stripeCustomerId: 'cus_test_client_a',
      tier: 'pro',
      onboardingStatus: 'live',
    },
    {
      id: '00000000-0000-0000-0000-000000000002',
      slug: 'globex-inc',
      companyName: 'Globex Inc',
      primaryContactEmail: 'qa-test-client-b@kairikos.com',
      stripeCustomerId: 'cus_test_client_b',
      tier: 'premium',
      onboardingStatus: 'in_progress',
    },
  ]);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
