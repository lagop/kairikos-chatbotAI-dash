import 'server-only';
import { createHmac } from 'crypto';
import type Stripe from 'stripe';
import { prisma } from './prisma';
import { isStripeConfigured, getStripe } from './stripe';
import {
  syncSubscriptionFromStripe,
  syncInvoiceFromStripe,
  deleteSubscriptionFromStripe,
  activateClientProductFromCheckout,
  expireClientProductFromCheckout,
} from './stripe-billing';
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
 * WP-19 — signature verification now goes through the Stripe SDK's own
 * `stripe.webhooks.constructEvent`, replacing a hand-rolled HMAC-SHA256 +
 * timing-safe-compare implementation. Same algorithm underneath (Stripe's
 * own code does exactly the header-parse + HMAC + timingSafeEqual dance
 * this file used to do by hand), but now it's Stripe's problem to keep in
 * sync with their own signing scheme — a hand-rolled copy is exactly the
 * kind of thing that quietly drifts the day Stripe changes a header
 * format detail.
 */

export interface WebhookResult {
  status: 'ok' | 'duplicate' | 'ignored' | 'signature_invalid' | 'missing_secret' | 'error';
  eventId?: string;
  eventType?: string;
  detail?: string;
}

export async function handleStripeEvent(
  rawBody: string,
  signatureHeader: string | null,
): Promise<{ statusCode: number; body: WebhookResult }> {
  if (!(await isStripeConfigured())) {
    return { statusCode: 503, body: { status: 'missing_secret', detail: 'STRIPE_SECRET_KEY not configured' } };
  }
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return { statusCode: 503, body: { status: 'missing_secret', detail: 'STRIPE_WEBHOOK_SECRET not configured' } };
  }
  if (!signatureHeader) {
    return { statusCode: 400, body: { status: 'signature_invalid', detail: 'Stripe-Signature header missing' } };
  }

  const event = await verifyAndParse(rawBody, signatureHeader, webhookSecret);
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
    //
    // WP-19 — this used to report `status: 'ok'` on a 500, which is a
    // lie the moment anyone reads the response body without also
    // checking the HTTP status: the handler failed, nothing here is ok.
    return { statusCode: 500, body: { status: 'error', eventId: event.id, eventType: event.type, detail: `handler_error:${message}` } };
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
    // WP-30 — self-serve checkout (POST /api/portal/billing/checkout)
    // pre-creates a ClientProduct in 'pending_payment' state before
    // redirecting to Stripe's hosted Checkout page. These two events are
    // what confirm or abandon that flow.
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      await activateClientProductFromCheckout(session);
      return 'checkout_session';
    }
    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session;
      await expireClientProductFromCheckout(session);
      return 'checkout_session';
    }
    default:
      return 'ignored';
  }
}

async function verifyAndParse(rawBody: string, signatureHeader: string, secret: string): Promise<Stripe.Event | null> {
  try {
    // 300s tolerance matches Stripe's own default and the 5-minute
    // window the hand-rolled version enforced before this WP.
    const stripe = await getStripe();
    return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret, 300);
  } catch {
    return null;
  }
}

function hashBody(rawBody: string): string {
  return createHmac('sha256', rawBody).digest('hex').slice(0, 64);
}
