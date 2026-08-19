import { NextResponse, type NextRequest } from 'next/server';
import { isDatabaseConfigured } from '@/lib/prisma';
import { generateDueDigests } from '@/lib/conversation-digest';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Canales Fase 7 — GET /api/cron/generate-conversation-digests
 *
 * Invoked by Vercel Cron (see vercel.json). Same auth convention as the
 * other cron routes: CRON_SECRET, sent back by Vercel as
 * `Authorization: Bearer <CRON_SECRET>` on every invocation.
 *
 * Runs hourly; generateDueDigests() re-checks isDigestDue per schedule
 * (morning/noon/evening slots or a custom interval), so a coarser real
 * invocation cadence (e.g. Vercel Hobby's daily-only cron) never causes
 * duplicate or too-frequent digests — it just means a client's digest
 * lands later than its configured slot.
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
  const result = await generateDueDigests();
  return NextResponse.json(result);
}
