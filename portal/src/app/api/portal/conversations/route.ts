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
      // own data — fall through to the real fetch below
    } else if (isKnownClientId(requestedClientId)) {
      // known other tenant → explicit 403
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    } else {
      // unknown id → simulate RLS "no rows"
      return NextResponse.json({ conversations: [] });
    }
  }
  if (isBackendConfigured) {
    const upstream = await fetch(`${PORTAL_API_BASE_URL}/portal/conversations`, {
      headers: { Authorization: req.headers.get('authorization') ?? '' },
      cache: 'no-store',
    });
    return new NextResponse(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json' } });
  }
  return NextResponse.json({
    conversations: Array.from({ length: 6 }).map((_, i) => ({
      id: `cnv_${1000 + i}`,
      startedAt: new Date(Date.now() - i * 1000 * 60 * 60).toISOString(),
      durationSeconds: 60 + (i % 5) * 45,
      outcome: i % 7 === 0 ? 'escalated' : i % 4 === 0 ? 'abandoned' : 'resolved',
      channel: i % 3 === 0 ? 'whatsapp' : i % 3 === 1 ? 'web' : 'instagram',
    })),
  });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
