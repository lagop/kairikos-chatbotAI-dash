import { NextResponse, type NextRequest } from 'next/server';
import { isDatabaseConfigured } from '@/lib/prisma';
import { syncAllDueConnections } from '@/lib/seo-analytics-sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * SEO con IA — GET /api/cron/sync-seo-analytics
 *
 * Same CRON_SECRET bearer-token convention as every other /api/cron/*
 * route. On the real deploy (VPS + Docker Compose, not Vercel — see
 * scripts/scheduler.sh) this path must be in scheduler.sh's ENDPOINTS
 * list to actually run; it is, in the same commit that adds this route.
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
