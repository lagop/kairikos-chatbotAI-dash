import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { syncReviewsForConnection, isSyncDue } from '@/lib/google-review-sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * WP-22a — POST /api/portal/google-business/sync
 *
 * The client-triggered "Sincronizar ahora" button on /portal/resenas.
 * Gated on the client having the 'reviews' product contracted — same
 * boundary the page itself enforces, checked again here because this is
 * a mutating endpoint a client could otherwise hit directly. 429s
 * (rather than silently no-op'ing) when the connection was synced too
 * recently, so the button's disabled/cooldown state in the UI has a
 * real HTTP status to key off instead of guessing the interval
 * client-side.
 */
export async function POST(req: NextRequest) {
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const hasReviews = await isProductContracted(prisma, resolved.clientId, 'reviews');
  if (!hasReviews) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const connection = await prisma.googleBusinessConnection.findFirst({
    where: { clientId: resolved.clientId, status: 'active' },
  });
  if (!connection) return NextResponse.json({ error: 'not_connected' }, { status: 404 });

  if (!isSyncDue(connection.lastSyncAt)) {
    return NextResponse.json({ error: 'too_recent', lastSyncAt: connection.lastSyncAt }, { status: 429 });
  }

  const result = await syncReviewsForConnection(connection);
  return NextResponse.json(result);
}
