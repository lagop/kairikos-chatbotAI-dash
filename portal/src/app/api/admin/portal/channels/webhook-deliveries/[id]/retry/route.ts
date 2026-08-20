import { NextResponse, type NextRequest } from 'next/server';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { isDatabaseConfigured } from '@/lib/prisma';
import { retryChannelWebhookDelivery } from '@/lib/channel-webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * WP: conexión de canales — Fase 5. POST /api/admin/portal/channels/webhook-deliveries/[id]/retry
 *
 * Manual re-fire for a ChannelWebhookDelivery stuck `failed` past the
 * cron sweep's MAX_ATTEMPTS ceiling (see retryPendingChannelWebhooks in
 * channel-webhook.ts) — the operator's escape hatch when automatic
 * backoff gave up. No TOTP step-up: this never touches money or a
 * Stripe-committing action, same class as the rest of the channels
 * admin surface.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const result = await retryChannelWebhookDelivery(params.id);
  if (result.error === 'delivery_not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(result);
}
