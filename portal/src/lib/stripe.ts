import 'server-only';
import Stripe from 'stripe';

let _stripe: Stripe | null = null;

/**
 * KAIA-4262 — Lazy Stripe SDK client.
 *
 * Reads STRIPE_SECRET_KEY from process.env at first call. Throws
 * `StripeUnavailableError` if the key is absent or empty so the
 * caller can return HTTP 503 instead of crashing the request.
 *
 * The SDK is cached at module scope to avoid re-parsing the key on
 * every route hit (Next.js route handlers are short-lived but the
 * module can be re-imported many times).
 */

export class StripeUnavailableError extends Error {
  constructor(message = 'STRIPE_SECRET_KEY not configured') {
    super(message);
    this.name = 'StripeUnavailableError';
  }
}

export function isStripeConfigured(): boolean {
  const key = process.env.STRIPE_SECRET_KEY;
  return typeof key === 'string' && key.length > 0;
}

export function getStripeApiVersion(): string {
  // Pin the API version so a future Stripe API change does not silently
  // change the shape of the webhook payloads the handler validates.
  return process.env.STRIPE_API_VERSION ?? '2024-06-20';
}

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new StripeUnavailableError();
  }
  _stripe = new Stripe(key, {
    apiVersion: getStripeApiVersion() as Stripe.LatestApiVersion,
    typescript: true,
    appInfo: {
      name: 'kairikos-portal',
      version: '0.1.0',
    },
  });
  return _stripe;
}

/**
 * Reset the cached client. Only used by tests so the same process can
 * pick up a new STRIPE_SECRET_KEY after process.env mutation. Not
 * called in production code paths.
 */
export function __resetStripeForTests(): void {
  _stripe = null;
}
