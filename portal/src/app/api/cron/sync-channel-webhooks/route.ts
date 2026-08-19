import { NextResponse, type NextRequest } from 'next/server';
import { isDatabaseConfigured } from '@/lib/prisma';
import { retryPendingChannelWebhooks } from '@/lib/channel-webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * WP: conexión de canales — GET /api/cron/sync-channel-webhooks
 *
 * Invoked by Vercel Cron (see vercel.json). Same auth convention as
 * /api/cron/sync-google-reviews: CRON_SECRET, sent back by Vercel as
 * `Authorization: Bearer <CRON_SECRET>` on every invocation.
 *
 * Retries every ChannelWebhookDelivery row stuck `failed` whose backoff
 * window has elapsed (see retryPendingChannelWebhooks in
 * channel-webhook.ts) — a delivery past MAX_ATTEMPTS sits `failed` for
 * an operator to retry manually from /admin/portal/[clientId] instead.
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
  const result = await retryPendingChannelWebhooks();
  return NextResponse.json(result);
}
