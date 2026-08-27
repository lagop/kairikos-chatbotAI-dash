import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { sweepDueProfiles } from '@/lib/seo-content-generation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * SEO con IA, Fase C — GET /api/cron/generate-seo-content
 *
 * Same auth convention as every other /api/cron/* route (CRON_SECRET
 * bearer token) and the same VPS-wiring requirement as every route
 * added this session: it must be in scripts/scheduler.sh's ENDPOINTS
 * list to actually run on the real deploy — it is, in the same commit.
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
  const result = await sweepDueProfiles(prisma);
  return NextResponse.json(result);
}
