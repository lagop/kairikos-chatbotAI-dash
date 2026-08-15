import 'server-only';
import Stripe from 'stripe';
import { resolveActiveStripeSecret } from './stripe-credentials';

let _stripe: Stripe | null = null;
let _stripeKeyFingerprint: string | null = null;

/**
 * KAIA-4262 — Lazy Stripe SDK client.
 *
 * Resolves the active Stripe secret key via resolveActiveStripeSecret()
 * (the DB-stored credential for the active mode, falling back to
 * STRIPE_SECRET_KEY from the environment — see stripe-credentials.ts).
 * Throws `StripeUnavailableError` if no key is available so the caller
 * can return HTTP 503 instead of crashing the request.
 *
 * The SDK instance is cached at module scope, keyed by a fingerprint of
 * the resolved key (last 8 chars — never the full key, even in memory
 * comparisons that could end up in a stack trace) so a credential
 * rotation or active-mode switch produces a fresh Stripe client instead
 * of silently reusing one built from a now-stale key.
 */

export class StripeUnavailableError extends Error {
  constructor(message = 'No Stripe secret key configured') {
    super(message);
    this.name = 'StripeUnavailableError';
  }
}

export async function isStripeConfigured(): Promise<boolean> {
  return (await resolveActiveStripeSecret()) !== null;
}

export function getStripeApiVersion(): string {
  // Pin the API version so a future Stripe API change does not silently
  // change the shape of the webhook payloads the handler validates.
  return process.env.STRIPE_API_VERSION ?? '2024-06-20';
}

function fingerprint(key: string): string {
  return key.slice(-8);
}

export async function getStripe(): Promise<Stripe> {
  const resolved = await resolveActiveStripeSecret();
  if (!resolved) {
    throw new StripeUnavailableError();
  }
  const fp = fingerprint(resolved.key);
  if (_stripe && _stripeKeyFingerprint === fp) {
    return _stripe;
  }
  _stripe = new Stripe(resolved.key, {
    apiVersion: getStripeApiVersion() as Stripe.LatestApiVersion,
    typescript: true,
    appInfo: {
      name: 'kairikos-portal',
      version: '0.1.0',
    },
  });
  _stripeKeyFingerprint = fp;
  return _stripe;
}

/**
 * Reset the cached client. Only used by tests so the same process can
 * pick up a new resolved key after mocking resolveActiveStripeSecret()
 * differently between cases. Not called in production code paths.
 */
export function __resetStripeForTests(): void {
  _stripe = null;
  _stripeKeyFingerprint = null;
}
