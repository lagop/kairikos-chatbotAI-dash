import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { logError } from './observability';

// =============================================================================
// WP: conexión de canales — the push bridge toward n8n. Portal → n8n
// only, one direction: n8n has no read access to this database, so
// every channel connect/disconnect/reconnect fires an authenticated
// outbound webhook. n8n owns subscribing each platform's own webhook
// (Telegram setWebhook, Meta's WABA/page subscription) once it has the
// new credential — this module's job ends at delivery.
//
// Every attempt is recorded in ChannelWebhookDelivery, not just
// failures — same "always audit" instinct as WebQuoteAudit/ReviewRequest
// elsewhere in this codebase, so an operator can see exactly what was
// sent and when, not just infer it from side effects.
//
// No exponential-backoff/retry utility existed anywhere in this repo
// before this (confirmed: the only prior "retry" — review-request-
// campaign.ts's retryFailedRequests — is a manual, no-backoff re-drive
// of DB rows, not scheduled). This is new, purpose-built for the cron
// at /api/cron/sync-channel-webhooks.
// =============================================================================

const HEADER_KEY = 'x-kairikos-internal-key';
const MAX_ATTEMPTS = 6;
// Minutes to wait before retrying, indexed by (attempts so far - 1):
// 5, 10, 20, 40, 80, capped at 240 for anything beyond that.
const BACKOFF_MINUTES = [5, 10, 20, 40, 80, 240] as const;

export type ChannelConnectionType = 'web' | 'telegram' | 'meta';

export interface ChannelWebhookEvent {
  connectionType: ChannelConnectionType;
  connectionId: string;
  clientId: string;
  // Free-form — e.g. { event: 'connected', channel: 'telegram', botUsername: '...' }
  payload: Record<string, unknown>;
}

export interface ChannelWebhookDeliveryResult {
  ok: boolean;
  deliveryId: string;
  status: 'delivered' | 'failed';
  error?: string;
}

function backoffMinutesFor(attempts: number): number {
  const index = Math.max(0, attempts - 1);
  return BACKOFF_MINUTES[Math.min(index, BACKOFF_MINUTES.length - 1)];
}

function isConfigured(): boolean {
  return Boolean(process.env.N8N_CHANNEL_WEBHOOK_URL && process.env.N8N_CHANNEL_WEBHOOK_SECRET);
}

/**
 * The actual outbound call — single attempt, never throws. Shared by the
 * first-attempt path (deliverChannelEvent) and every retry path (cron
 * sweep, manual operator retry) so the request shape and error handling
 * never drift between them.
 */
async function attemptDelivery(payload: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = process.env.N8N_CHANNEL_WEBHOOK_URL;
  const secret = process.env.N8N_CHANNEL_WEBHOOK_SECRET;
  if (!url || !secret) {
    return { ok: false, error: 'not_configured: N8N_CHANNEL_WEBHOOK_URL/N8N_CHANNEL_WEBHOOK_SECRET unset' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HEADER_KEY]: secret },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `webhook_error:${res.status}:${body.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown_error' };
  }
}

/**
 * Fires immediately when a channel connects/disconnects/reconnects.
 * Always creates a ChannelWebhookDelivery row (the audit trail), then
 * attempts delivery once. A failed first attempt is NOT retried
 * synchronously here — it's left `failed` for the cron sweep
 * (retryPendingChannelWebhooks) to pick up on its own schedule. Never
 * throws — the caller (a connect/disconnect route) must not fail its
 * own response just because n8n is unreachable.
 */
export async function deliverChannelEvent(event: ChannelWebhookEvent): Promise<ChannelWebhookDeliveryResult> {
  const delivery = await prisma.channelWebhookDelivery.create({
    data: {
      connectionType: event.connectionType,
      connectionId: event.connectionId,
      clientId: event.clientId,
      payload: event.payload as Prisma.InputJsonValue,
      status: 'pending',
    },
  });

  const fullPayload = {
    deliveryId: delivery.id,
    connectionType: event.connectionType,
    connectionId: event.connectionId,
    clientId: event.clientId,
    ...event.payload,
  };
  const attempt = await attemptDelivery(fullPayload);

  if (attempt.ok) {
    await prisma.channelWebhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'delivered', attempts: 1, lastAttemptAt: new Date() },
    });
    return { ok: true, deliveryId: delivery.id, status: 'delivered' };
  }

  await prisma.channelWebhookDelivery.update({
    where: { id: delivery.id },
    data: { status: 'failed', attempts: 1, lastAttemptAt: new Date(), lastError: attempt.error.slice(0, 500) },
  });
  logError('channel_webhook.deliver_failed', new Error(attempt.error), {
    deliveryId: delivery.id,
    connectionType: event.connectionType,
  }, 'warn');
  return { ok: false, deliveryId: delivery.id, status: 'failed', error: attempt.error };
}

/**
 * Retries a single delivery by id — used by both the cron sweep and the
 * operator's manual "reintentar" action (Fase 5). Bypasses the backoff
 * window when called directly (an explicit retry, human or scheduled,
 * always attempts now); the cron's own query is what enforces the
 * window before calling this.
 */
export async function retryChannelWebhookDelivery(deliveryId: string): Promise<ChannelWebhookDeliveryResult> {
  const delivery = await prisma.channelWebhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery) {
    return { ok: false, deliveryId, status: 'failed', error: 'delivery_not_found' };
  }

  const fullPayload = {
    deliveryId: delivery.id,
    connectionType: delivery.connectionType,
    connectionId: delivery.connectionId,
    clientId: delivery.clientId,
    ...(delivery.payload as Record<string, unknown>),
  };
  const attempt = await attemptDelivery(fullPayload);
  const nextAttempts = delivery.attempts + 1;

  if (attempt.ok) {
    await prisma.channelWebhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'delivered', attempts: nextAttempts, lastAttemptAt: new Date(), lastError: null },
    });
    return { ok: true, deliveryId: delivery.id, status: 'delivered' };
  }

  await prisma.channelWebhookDelivery.update({
    where: { id: delivery.id },
    data: { status: 'failed', attempts: nextAttempts, lastAttemptAt: new Date(), lastError: attempt.error.slice(0, 500) },
  });
  return { ok: false, deliveryId: delivery.id, status: 'failed', error: attempt.error };
}

export interface RetrySweepResult {
  scanned: number;
  delivered: number;
  stillFailed: number;
  skippedNotConfigured: boolean;
}

/**
 * The cron entry point (/api/cron/sync-channel-webhooks). Retries every
 * `failed` delivery whose backoff window has elapsed and whose attempt
 * count hasn't hit MAX_ATTEMPTS — past that ceiling a row sits `failed`
 * until an operator retries it manually (Fase 5), it is never retried
 * automatically forever.
 */
export async function retryPendingChannelWebhooks(): Promise<RetrySweepResult> {
  if (!isConfigured()) {
    return { scanned: 0, delivered: 0, stillFailed: 0, skippedNotConfigured: true };
  }

  const candidates = await prisma.channelWebhookDelivery.findMany({
    where: { status: 'failed', attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { lastAttemptAt: 'asc' },
  });

  const due = candidates.filter((d) => {
    if (!d.lastAttemptAt) return true;
    const dueAt = new Date(d.lastAttemptAt.getTime() + backoffMinutesFor(d.attempts) * 60_000);
    return dueAt <= new Date();
  });

  let delivered = 0;
  let stillFailed = 0;
  for (const delivery of due) {
    const result = await retryChannelWebhookDelivery(delivery.id);
    if (result.ok) delivered += 1;
    else stillFailed += 1;
  }

  return { scanned: due.length, delivered, stillFailed, skippedNotConfigured: false };
}
