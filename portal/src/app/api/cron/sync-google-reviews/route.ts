import { NextResponse, type NextRequest } from 'next/server';
import { isDatabaseConfigured } from '@/lib/prisma';
import { syncAllDueConnections } from '@/lib/google-review-sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * WP-22a — GET /api/cron/sync-google-reviews
 *
 * Invoked by Vercel Cron (see vercel.json). Auth follows Vercel's own
 * convention: set CRON_SECRET, Vercel sends it back as
 * `Authorization: Bearer <CRON_SECRET>` on every cron invocation — any
 * request without a matching header is rejected, so this endpoint can't
 * be used to trigger a sync sweep from outside Vercel's scheduler.
 *
 * Schedule note: vercel.json requests every 6 hours, but Vercel's Hobby
 * plan only runs cron jobs at daily granularity — on Hobby this
 * effectively runs once a day regardless of the schedule string. Either
 * way `syncAllDueConnections` re-checks `isSyncDue` per connection
 * (GOOGLE_REVIEWS_SYNC_MIN_INTERVAL_MINUTES), so a coarser real
 * invocation cadence never causes duplicate/too-frequent syncs — it just
 * means reviews go stale for longer between runs on that plan tier.
 */
function isAuthorizedCronRequest(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await syncAllDueConnections();
  return NextResponse.json(result);
}
