import { createHmac, timingSafeEqual } from 'node:crypto';

// =============================================================================
// WP-XX — Twilio webhook signature verification.
//
// The voice and recording webhooks are PUBLIC endpoints with no session
// and no shared-secret header: Twilio's servers call them directly. The
// signature is the only thing standing between them and anyone who can
// guess the URL. Without it, a stranger could POST fabricated calls and
// make the portal message real people from a client's WhatsApp number.
//
// Twilio's documented algorithm:
//   1. Take the full request URL, exactly as Twilio has it configured.
//   2. Append every POST parameter, sorted by name, as name + value
//      concatenated with no separators.
//   3. HMAC-SHA1 that string with the account's auth token.
//   4. Base64. Compare against the X-Twilio-Signature header.
//
// Deliberately dependency-free and pure so it can be unit-tested by
// constructing a signature with the same primitives — the one thing you
// cannot verify by inspection is whether the concatenation order matches
// Twilio's, and a test that builds and then verifies proves the round
// trip rather than restating the implementation.
// =============================================================================

export function buildTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(payload, 'utf-8')).digest('base64');
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null,
): boolean {
  if (!signature) return false;
  const expected = buildTwilioSignature(authToken, url, params);
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(signature, 'utf-8');
  // timingSafeEqual throws on length mismatch, which is itself a leak of
  // "wrong length" vs "wrong content" — but a length mismatch here means
  // a malformed signature, not a near-miss guess, so short-circuiting is
  // fine and avoids the throw.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The URL Twilio signed — which is NOT necessarily what `req.url` says.
 *
 * Behind nginx the app sees an internal host, so reconstructing from the
 * request alone produces a different string from the one Twilio hashed
 * and every signature fails. TWILIO_WEBHOOK_BASE_URL pins the public
 * origin; the X-Forwarded-* fallback covers local development and any
 * deployment where the proxy is honest about the original host.
 *
 * Note the fallback trusts client-supplied headers. That is acceptable
 * only because a forged host produces a signature that does NOT verify —
 * an attacker gains nothing by lying here. Pin the env var in production
 * anyway, so a proxy misconfiguration fails loudly rather than silently
 * rejecting every real webhook.
 */
export function resolveWebhookUrl(req: { url: string; headers: Headers }, path: string): string {
  const configured = process.env.TWILIO_WEBHOOK_BASE_URL ?? process.env.NEXT_PUBLIC_PORTAL_URL;
  if (configured) {
    return `${configured.replace(/\/+$/, '')}${path}`;
  }
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host) return `${proto}://${host}${path}`;
  return new URL(path, req.url).toString();
}

/** Flatten a form-encoded body into the plain string map the signature
 *  algorithm expects. Twilio never sends repeated keys on these webhooks;
 *  if it ever did, last-wins matches how its own helper libraries behave. */
export function formDataToParams(form: FormData): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value;
  }
  return params;
}
