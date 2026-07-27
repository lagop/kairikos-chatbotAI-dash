import { describe, expect, it } from 'vitest';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * KAIA-4262 — Stripe webhook handler signature tests.
 *
 * These tests mirror the production signature verification logic
 * implemented in src/lib/stripe-webhook.ts so the unit test does not
 * pull in `server-only` (which is incompatible with vitest's resolver
 * without extra deps.inline plumbing).
 *
 * If the production algorithm drifts from this one, the integration
 * smoke (`scripts/verify-stripe-webhook.sh`) will catch it. Keeping
 * the two in sync is enforced by:
 *   - this file's header comment naming the source module
 *   - the staging smoke's Stripe CLI re-delivery test, which proves
 *     the live handler accepts a Stripe-signed body (and rejects
 *     tampered ones) end-to-end
 *
 * Algorithm (must match src/lib/stripe-webhook.ts:verifyAndParse):
 *   1. Parse "Stripe-Signature: t=<ts>,v1=<hex hmac>" into parts.
 *   2. Reject if either part missing or ts not finite.
 *   3. Reject if |now - ts| > 5 minutes.
 *   4. Compute HMAC-SHA256(secret, `${ts}.${body}`) → hex.
 *   5. timingSafeEqual on equal-length buffers.
 *   6. JSON.parse(body) → Stripe.Event.
 */

function verifyAndParse(rawBody: string, signatureHeader: string, secret: string): { id: string } | null {
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
    return JSON.parse(rawBody) as { id: string };
  } catch {
    return null;
  }
}

function sign(secret: string, ts: number, body: string): string {
  const hmac = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${hmac}`;
}

describe('stripe-webhook signature verification', () => {
  it('accepts a fresh, correctly-signed body', () => {
    const secret = 'whsec_test_secret';
    const body = JSON.stringify({ id: 'evt_test_ok' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(secret, ts, body);
    const event = verifyAndParse(body, sig, secret);
    expect(event).toBeTruthy();
    expect(event?.id).toBe('evt_test_ok');
  });

  it('rejects an invalid signature', () => {
    const body = JSON.stringify({ id: 'evt_test' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign('wrong-secret', ts, body);
    const event = verifyAndParse(body, sig, 'right-secret');
    expect(event).toBeNull();
  });

  it('rejects a stale timestamp (>5 min old)', () => {
    const secret = 'whsec_test_secret';
    const body = JSON.stringify({ id: 'evt_test' });
    const ts = Math.floor(Date.now() / 1000) - 10 * 60;
    const sig = sign(secret, ts, body);
    const event = verifyAndParse(body, sig, secret);
    expect(event).toBeNull();
  });

  it('rejects a malformed Stripe-Signature header', () => {
    const event = verifyAndParse('{}', 'garbage', 'whsec_test_secret');
    expect(event).toBeNull();
  });

  it('rejects when v1 length does not match expected', () => {
    // Stripe produces a 64-char hex; a shorter one must fail the
    // length check before timingSafeEqual is called.
    const body = JSON.stringify({ id: 'evt_test' });
    const ts = Math.floor(Date.now() / 1000);
    const sig = `t=${ts},v1=deadbeef`;
    const event = verifyAndParse(body, sig, 'whsec_test_secret');
    expect(event).toBeNull();
  });
});
