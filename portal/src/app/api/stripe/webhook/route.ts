import { type NextRequest } from 'next/server';
import { handleStripeEvent } from '@/lib/stripe-webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * KAIA-4262 — Stripe webhook endpoint.
 *
 * Route shape:
 *   POST /api/stripe/webhook
 *
 * The route reads the raw body string (NOT parsed JSON) so the
 * Stripe-Signature HMAC verification has byte-exact bytes to verify
 * against. Stripe signs the raw body, never the parsed JSON, so a
 * JSON-parsed body would fail signature verification.
 *
 * Responses:
 *   200 { status: 'ok' }                     — processed
 *   200 { status: 'duplicate', eventId }     — already processed (idempotency short-circuit)
 *   200 { status: 'ignored', eventType }     — unhandled event type, recorded
 *   400 { status: 'signature_invalid' }      — bad / missing / expired signature
 *   500 { status: 'ok', detail: 'handler_error:…' } — handler threw; Stripe will retry
 *   503 { status: 'missing_secret' }         — STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET not set
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get('stripe-signature');
  const result = await handleStripeEvent(rawBody, sig);
  return new Response(JSON.stringify(result.body), {
    status: result.statusCode,
    headers: { 'content-type': 'application/json' },
  });
}
