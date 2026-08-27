import { NextResponse, type NextRequest } from 'next/server';
import { isDatabaseConfigured } from '@/lib/prisma';
import { syncAllDueConnections } from '@/lib/seo-search-console-sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * SEO con IA, Fase B — GET /api/cron/sync-seo-search-console
 *
 * Auth follows the same convention as every other /api/cron/* route in
 * this repo: CRON_SECRET sent back as `Authorization: Bearer
 * <CRON_SECRET>`. On the real deploy (VPS + Docker Compose, NOT
 * Vercel — see scripts/scheduler.sh), this path must be added to
 * scheduler.sh's ENDPOINTS list to actually run; it is, in the same
 * commit that adds this route.
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
