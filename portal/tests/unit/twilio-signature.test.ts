// =============================================================================
// WP-XX — unit tests for Twilio webhook signature verification.
//
// This is the only authentication on two public, session-less endpoints,
// so the tests are deliberately adversarial: they assert what must be
// REJECTED at least as hard as what must be accepted.
//
// The round-trip approach (build a signature, then verify it) proves the
// parameter concatenation order matches between the two halves — the one
// property that cannot be checked by reading the implementation.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import {
  buildTwilioSignature,
  verifyTwilioSignature,
  resolveWebhookUrl,
  formDataToParams,
} from '@/lib/telephony/twilio-signature';

const TOKEN = 'test_auth_token_do_not_use';
const URL_ = 'https://portal.example.com/api/webhooks/twilio/voice';
const PARAMS = { CallSid: 'CA123', From: '+34600111222', To: '+34910000001' };

describe('verifyTwilioSignature', () => {
  it('accepts a signature built over the same url and params', () => {
    const sig = buildTwilioSignature(TOKEN, URL_, PARAMS);
    expect(verifyTwilioSignature(TOKEN, URL_, PARAMS, sig)).toBe(true);
  });

  it('is insensitive to the order the params were supplied in — Twilio sorts by name', () => {
    const a = buildTwilioSignature(TOKEN, URL_, { CallSid: 'CA1', To: '+34910000001', From: '+34600111222' });
    const b = buildTwilioSignature(TOKEN, URL_, { From: '+34600111222', CallSid: 'CA1', To: '+34910000001' });
    expect(a).toBe(b);
  });

  it('rejects a missing signature', () => {
    expect(verifyTwilioSignature(TOKEN, URL_, PARAMS, null)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL_, PARAMS, '')).toBe(false);
  });

  it('rejects a signature made with a different auth token', () => {
    const sig = buildTwilioSignature('someone_elses_token', URL_, PARAMS);
    expect(verifyTwilioSignature(TOKEN, URL_, PARAMS, sig)).toBe(false);
  });

  it('rejects a signature made for a different url', () => {
    const sig = buildTwilioSignature(TOKEN, 'https://evil.example.com/api/webhooks/twilio/voice', PARAMS);
    expect(verifyTwilioSignature(TOKEN, URL_, PARAMS, sig)).toBe(false);
  });

  it('rejects when any parameter value was tampered with', () => {
    const sig = buildTwilioSignature(TOKEN, URL_, PARAMS);
    // The attack this prevents: replaying a genuine call but swapping the
    // caller, so the portal messages a number of the attacker's choosing.
    expect(verifyTwilioSignature(TOKEN, URL_, { ...PARAMS, From: '+34600999999' }, sig)).toBe(false);
  });

  it('rejects when a parameter was added or removed', () => {
    const sig = buildTwilioSignature(TOKEN, URL_, PARAMS);
    expect(verifyTwilioSignature(TOKEN, URL_, { ...PARAMS, Extra: 'x' }, sig)).toBe(false);
    const { From: _dropped, ...withoutFrom } = PARAMS;
    expect(verifyTwilioSignature(TOKEN, URL_, withoutFrom, sig)).toBe(false);
  });

  it('rejects a garbage signature of the wrong length without throwing', () => {
    expect(() => verifyTwilioSignature(TOKEN, URL_, PARAMS, 'short')).not.toThrow();
    expect(verifyTwilioSignature(TOKEN, URL_, PARAMS, 'short')).toBe(false);
  });

  it('handles an empty parameter set (the url alone is signed)', () => {
    const sig = buildTwilioSignature(TOKEN, URL_, {});
    expect(verifyTwilioSignature(TOKEN, URL_, {}, sig)).toBe(true);
    expect(verifyTwilioSignature(TOKEN, URL_, { CallSid: 'CA1' }, sig)).toBe(false);
  });
});

describe('resolveWebhookUrl', () => {
  const OLD = { base: process.env.TWILIO_WEBHOOK_BASE_URL, portal: process.env.NEXT_PUBLIC_PORTAL_URL };

  afterEach(() => {
    process.env.TWILIO_WEBHOOK_BASE_URL = OLD.base;
    process.env.NEXT_PUBLIC_PORTAL_URL = OLD.portal;
  });

  function req(headers: Record<string, string>, url = 'http://internal:3000/api/webhooks/twilio/voice') {
    return { url, headers: new Headers(headers) };
  }

  it('prefers the pinned base url — behind nginx the request host is the internal one', () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = 'https://portal.example.com';
    expect(resolveWebhookUrl(req({ host: 'internal:3000' }), '/api/webhooks/twilio/voice')).toBe(
      'https://portal.example.com/api/webhooks/twilio/voice',
    );
  });

  it('tolerates a trailing slash on the configured base', () => {
    process.env.TWILIO_WEBHOOK_BASE_URL = 'https://portal.example.com/';
    expect(resolveWebhookUrl(req({}), '/api/webhooks/twilio/voice')).toBe(
      'https://portal.example.com/api/webhooks/twilio/voice',
    );
  });

  it('falls back to the portal url when no telephony-specific base is set', () => {
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
    process.env.NEXT_PUBLIC_PORTAL_URL = 'https://portal.kairikos.com';
    expect(resolveWebhookUrl(req({}), '/api/webhooks/twilio/recording')).toBe(
      'https://portal.kairikos.com/api/webhooks/twilio/recording',
    );
  });

  it('reconstructs from forwarded headers when nothing is configured', () => {
    delete process.env.TWILIO_WEBHOOK_BASE_URL;
    delete process.env.NEXT_PUBLIC_PORTAL_URL;
    const url = resolveWebhookUrl(
      req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'portal.example.com' }),
      '/api/webhooks/twilio/voice',
    );
    expect(url).toBe('https://portal.example.com/api/webhooks/twilio/voice');
  });
});

describe('formDataToParams', () => {
  it('flattens string fields and drops non-string entries', () => {
    const form = new FormData();
    form.set('CallSid', 'CA1');
    form.set('From', '+34600111222');
    form.set('file', new Blob(['x']), 'x.txt');
    expect(formDataToParams(form)).toEqual({ CallSid: 'CA1', From: '+34600111222' });
  });
});
