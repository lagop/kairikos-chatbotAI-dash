import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveReviewConnection } from '@/lib/review-locations';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { hasGoogleBusinessConnectAccess } from '@/lib/google-business';
import { syncReviewsForConnection, isSyncDue } from '@/lib/google-review-sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * WP-22a — POST /api/portal/google-business/sync
 *
 * The client-triggered "Sincronizar ahora" button on /portal/resenas.
 * Gated on hasGoogleBusinessConnectAccess (the 'reviews' product OR
 * 'recall', which bundles the same review flow over WhatsApp) — same
 * boundary the page itself enforces, checked again here because this is
 * a mutating endpoint a client could otherwise hit directly. 429s
 * (rather than silently no-op'ing) when the connection was synced too
 * recently, so the button's disabled/cooldown state in the UI has a
 * real HTTP status to key off instead of guessing the interval
 * client-side.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const hasAccess = await hasGoogleBusinessConnectAccess(resolved.clientId);
  if (!hasAccess) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // Fase 3 — por query, porque este POST no tiene cuerpo.
  const connectionId = new URL(req.url).searchParams.get('connectionId');

  // Fase 3 — el local sobre el que se sincroniza viene en la petición.
  // Antes era findFirst({ clientId, status: 'active' }), que con dos
  // locales sincronizaba «el que devolviera Postgres primero».
  const target = await resolveReviewConnection(prisma, resolved.clientId, connectionId);
  if (!target) {
    return NextResponse.json({ error: connectionId ? 'not_connected' : 'location_required' }, { status: 404 });
  }
  const connection = target;

  if (!isSyncDue(connection.lastSyncAt)) {
    return NextResponse.json({ error: 'too_recent', lastSyncAt: connection.lastSyncAt }, { status: 429 });
  }

  const result = await syncReviewsForConnection(connection);
  return NextResponse.json(result);
}
