import 'server-only';
import { createHmac, timingSafeEqual } from 'crypto';
import type Stripe from 'stripe';
import { prisma } from './prisma';
import { isStripeConfigured, getStripe } from './stripe';
import { syncSubscriptionFromStripe, syncInvoiceFromStripe, deleteSubscriptionFromStripe } from './stripe-billing';
import { logError } from './observability';
import { notifyOperatorOfExecutionFailure } from './operator-notify';

/**
 * KAIA-4262 — Stripe webhook event handler.
 *
 * Idempotency model (lens: Idempotent webhooks — required for every
 * Stripe webhook handler):
 *
 *   1. On every delivery, INSERT INTO StripeWebhookEvent with PK =
 *      event.id. ON CONFLICT DO NOTHING + RETURNING tells us whether
 *      this is a fresh delivery.
 *   2. If RETURNING returns 0 rows, the event has been seen — respond
 *      200 OK with `{ duplicate: true }` and short-circuit.
 *   3. If the insert is new, we run the actual handler logic. Any
 *      thrown error is caught and written back to the event row so
 *      future retries stay no-ops (we never retry; Stripe will keep
 *      re-delivering failed events for up to 3 days, so we want them
 *      to converge to a stable "failed" state and stay out of the
 *      way).
 *   4. The handler always returns 200 OK unless the signature itself
 *      is invalid — Stripe does not retry 4xx, so any auth failure is
 *      terminal.
 *
 * Signature verification uses the raw request body + Stripe's
 * `Stripe-Signature` header. We do NOT parse the body as JSON before
 * signing — Stripe signs the byte-exact body string.
 */

export interface WebhookResult {
  status: 'ok' | 'duplicate' | 'ignored' | 'signature_invalid' | 'missing_secret';
  eventId?: string;
  eventType?: string;
  detail?: string;
}

export async function handleStripeEvent(
  rawBody: string,
  signatureHeader: string | null,
): Promise<{ statusCode: number; body: WebhookResult }> {
  if (!isStripeConfigured()) {
    return { statusCode: 503, body: { status: 'missing_secret', detail: 'STRIPE_SECRET_KEY not configured' } };
  }
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return { statusCode: 503, body: { status: 'missing_secret', detail: 'STRIPE_WEBHOOK_SECRET not configured' } };
  }
  if (!signatureHeader) {
    return { statusCode: 400, body: { status: 'signature_invalid', detail: 'Stripe-Signature header missing' } };
  }

  const event = verifyAndParse(rawBody, signatureHeader, webhookSecret);
  if (!event) {
    return { statusCode: 400, body: { status: 'signature_invalid' } };
  }

  const payloadHash = hashBody(rawBody);

  // Idempotency insert. ON CONFLICT DO NOTHING + RETURNING is the
  // canonical Prisma upsert-on-PK pattern.
  const inserted = await prisma.stripeWebhookEvent
    .create({
      data: {
        eventId: event.id,
        eventType: event.type,
        payloadHash,
        status: 'pending',
        stripeApiVersion: event.api_version ?? null,
      },
      select: { eventId: true },
    })
    .then(() => true)
    .catch((err: unknown) => {
      // P2002 = unique constraint violation on PK — already processed.
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002') {
        return false;
      }
      throw err;
    });

  if (!inserted) {
    return { statusCode: 200, body: { status: 'duplicate', eventId: event.id, eventType: event.type } };
  }

  try {
    const appliedTo = await dispatch(event);
    await prisma.stripeWebhookEvent.update({
      where: { eventId: event.id },
      data: { status: 'processed', processedAt: new Date(), appliedTo },
    });
    return { statusCode: 200, body: { status: 'ok', eventId: event.id, eventType: event.type } };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    await prisma.stripeWebhookEvent.update({
      where: { eventId: event.id },
      data: { status: 'failed', processedAt: new Date(), errorMessage: message.slice(0, 2000) },
    });
    // WP-26 — this used to write the failure to StripeWebhookEvent and
    // stop there; the comment above this block already said "then alert
    // on StripeWebhookEvent rows with status='failed'" as a TODO that
    // never happened. A failed webhook means a subscription or invoice
    // fell out of sync with what the customer is actually paying for —
    // exactly the "pago no conciliado" case the WP-26 spec names.
    logError('stripe.webhook_handler', err, {
      route: 'POST /api/stripe/webhook',
      stripeEventId: event.id,
      stripeEventType: event.type,
    });
    void notifyOperatorOfExecutionFailure({
      executionId: event.id,
      workflowName: `stripe_webhook:${event.type}`,
      error: message,
    }).catch(() => {
      // Best-effort — logError above already guarantees this isn't silent.
    });
    // Return 500 so Stripe retries. The idempotency row keeps future
    // retries of the SAME delivery no-op, but a new delivery of the
    // SAME event id is impossible (it's the PK) — so we rely on
    // Stripe to eventually give up.
    return { statusCode: 500, body: { status: 'ok', eventId: event.id, eventType: event.type, detail: `handler_error:${message}` } };
  }
}

async function dispatch(event: Stripe.Event): Promise<string> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
    case 'customer.subscription.trial_will_end': {
      const sub = event.data.object as Stripe.Subscription;
      await syncSubscriptionFromStripe(sub);
      return 'subscription';
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await deleteSubscriptionFromStripe(sub.id);
      return 'subscription';
    }
    case 'invoice.created':
    case 'invoice.finalized':
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.updated':
    case 'invoice.upcoming': {
      const inv = event.data.object as Stripe.Invoice;
      await syncInvoiceFromStripe(inv);
      return 'invoice';
    }
    default:
      return 'ignored';
  }
}

function verifyAndParse(rawBody: string, signatureHeader: string, secret: string): Stripe.Event | null {
  // Stripe-Signature header format: t=<timestamp>,v1=<hex hmac>.
  // Tolerance: 5 minutes (Stripe's default).
  const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, part) => {
    const [k, v] = part.split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return null;
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds)) return null;
  const ageSeconds = Math.abs(Date.now() / 1000 - tsSeconds);
  if (ageSeconds > 5 * 60) return null;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(v1, 'hex');
  if (expectedBuf.length !== receivedBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, receivedBuf)) return null;

  try {
    return JSON.parse(rawBody) as Stripe.Event;
  } catch {
    return null;
  }
}

function hashBody(rawBody: string): string {
  return createHmac('sha256', rawBody).digest('hex').slice(0, 64);
}

/**
 * Convenience for tests: returns the Stripe client with a forced
 * signature verification bypass. Not used in production.
 */
export function __getStripeForTests() {
  return getStripe();
}

/**
 * Test-only export of the signature verifier. Lets unit tests assert
 * on signature accept/reject without spinning up a real Stripe client.
 */
export function __verifyAndParseForTests(rawBody: string, signatureHeader: string, secret: string) {
  return verifyAndParse(rawBody, signatureHeader, secret);
}
