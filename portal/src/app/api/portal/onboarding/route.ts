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
      return NextResponse.json({ timeline: [] });
    }
  }
  if (isBackendConfigured) {
    const upstream = await fetch(`${PORTAL_API_BASE_URL}/portal/onboarding-status`, {
      headers: { Authorization: req.headers.get('authorization') ?? '' },
      cache: 'no-store',
    });
    return new NextResponse(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json' } });
  }
  return NextResponse.json({
    timeline: [
      { id: 'evt-t0', step: 't_plus_0', label: 'Bienvenida', description: 'Email enviado', occurredAt: '2026-05-22T10:05:00.000Z', status: 'done' },
      { id: 'evt-t3', step: 't_plus_3', label: 'Configuración', description: 'Hecho', occurredAt: '2026-05-25T11:20:00.000Z', status: 'done' },
      { id: 'evt-t7', step: 't_plus_7', label: 'Producción', description: 'Hecho', occurredAt: '2026-05-29T09:00:00.000Z', status: 'done' },
      { id: 'evt-t14', step: 't_plus_14', label: 'Revisión', description: 'Pendiente', occurredAt: null, status: 'current' },
    ],
  });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
