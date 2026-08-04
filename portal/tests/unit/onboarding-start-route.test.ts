// =============================================================================
// KAIA-10264 (H2) — Unit tests for POST /api/onboarding/start.
//
// Contract under test (idempotency):
//
//   * Two consecutive POSTs with the same { email } and no
//     `idempotencyKey` body field and no `x-idempotency-key` header
//     must resolve to the SAME `sessionToken` / `tenantSlug`, with
//     `duplicate: false` on the first call and `duplicate: true` on
//     the second.
//   * When the caller sends an explicit `x-idempotency-key` header,
//     that header value is honoured (and dedupes independently of
//     email).
//   * When the caller sends an explicit `idempotencyKey` body field,
//     that wins over both the header and the email-derived default.
//   * The email-derived fallback MUST be deterministic for a given
//     email regardless of surrounding whitespace / case so retries
//     collapse onto the same OnboardingSession row.
//
// Prisma is fully mocked so the test exercises the route's idempotency
// chain without touching Postgres. The DB-configured path goes
// through `startOnboardingSession` (already covered by the smoke
// harness in scripts/smoke-onboarding-activation.ts); the route is
// the new integration point under test here.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const startOnboardingSession = vi.fn();
const getOnboardingSession = vi.fn();
const isDatabaseConfigured = true;
const isStripeConfigured = vi.fn();

vi.mock('@/lib/onboarding/sessions', async () => {
  const actual = await vi.importActual<typeof import('@/lib/onboarding/sessions')>(
    '@/lib/onboarding/sessions',
  );
  return {
    ...actual,
    startOnboardingSession: (...args: unknown[]) => startOnboardingSession(...args),
    getOnboardingSession: (...args: unknown[]) => getOnboardingSession(...args),
  };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    onboardingSession: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
  isDatabaseConfigured: true,
}));

vi.mock('@/lib/stripe', () => ({
  getStripe: vi.fn(),
  isStripeConfigured: () => isStripeConfigured(),
}));

import { POST } from '@/app/api/onboarding/start/route';
import { hashEmail } from '@/lib/onboarding/sessions';

const FIXED_TOKEN = 'fixed-session-token-1234';
const FIXED_SLUG = 'aurora-test-fixed';

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return {
    json: async () => body,
    headers: {
      get: (name: string) => {
        const lower = name.toLowerCase();
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === lower) return v;
        }
        return null;
      },
    },
  } as unknown as Parameters<typeof POST>[0];
}

async function bodyOf(res: Response): Promise<{ status: number; body: any }> {
  const clone = res.clone();
  const body = await clone.json();
  return { status: res.status, body };
}

beforeEach(() => {
  startOnboardingSession.mockReset();
  startOnboardingSession.mockImplementation(async (input: { email: string; idempotencyKey: string }) => {
    return {
      sessionToken: FIXED_TOKEN,
      tenantSlug: FIXED_SLUG,
      productId: null,
      clientProductId: null,
      duplicate: false,
      _idem: input.idempotencyKey,
      _email: input.email,
    };
  });
  isStripeConfigured.mockReturnValue(true);
});

describe('POST /api/onboarding/start — KAIA-10264 H2 dedup', () => {
  it('400s on invalid JSON', async () => {
    const res = await POST(makeRequest(null));
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_body');
    expect(startOnboardingSession).not.toHaveBeenCalled();
  });

  it('400s when email is missing', async () => {
    const res = await POST(makeRequest({ source: 'self_serve_landing' }));
    const { status, body } = await bodyOf(res);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_body');
    expect(startOnboardingSession).not.toHaveBeenCalled();
  });

  it('uses SHA-256(email) as the default idempotency key when neither body nor header supplies one', async () => {
    const email = 'qa-idem-evidence-1785857515@kairikos.test';
    const res = await POST(makeRequest({ email, source: 'self_serve_landing' }));
    const { status } = await bodyOf(res);
    expect(status).toBe(200);
    expect(startOnboardingSession).toHaveBeenCalledTimes(1);
    const call = startOnboardingSession.mock.calls[0]![0] as { idempotencyKey: string; email: string };
    expect(call.idempotencyKey).toBe(hashEmail(email));
    expect(call.email).toBe(email);
  });

  it('two consecutive POSTs with the same email and no key produce the SAME idempotencyKey — AC #7 regression guard', async () => {
    const email = 'qa-idem-evidence-1785857515@kairikos.test';
    await POST(makeRequest({ email, source: 'self_serve_landing' }));
    await POST(makeRequest({ email, source: 'self_serve_landing' }));
    expect(startOnboardingSession).toHaveBeenCalledTimes(2);
    const key1 = (startOnboardingSession.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey;
    const key2 = (startOnboardingSession.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey;
    expect(key1).toBe(key2);
    expect(key1).toBe(hashEmail(email));
  });

  it('email case normalisation collapses to the same idempotency key (whitespace is rejected by Zod email() upstream)', async () => {
    const a = 'Aurora@Example.com';
    const b = 'aurora@example.com';
    await POST(makeRequest({ email: a, source: 'self_serve_landing' }));
    await POST(makeRequest({ email: b, source: 'self_serve_landing' }));
    const key1 = (startOnboardingSession.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey;
    const key2 = (startOnboardingSession.mock.calls[1]![0] as { idempotencyKey: string }).idempotencyKey;
    expect(key1).toBe(key2);
  });

  it('header x-idempotency-key wins over the email-derived default', async () => {
    const email = 'qa-header@example.com';
    await POST(
      makeRequest(
        { email, source: 'self_serve_landing' },
        { 'x-idempotency-key': 'header-supplied-key-1234' },
      ),
    );
    const call = startOnboardingSession.mock.calls[0]![0] as { idempotencyKey: string };
    expect(call.idempotencyKey).toBe('header-supplied-key-1234');
  });

  it('body.idempotencyKey wins over x-idempotency-key', async () => {
    const email = 'qa-body@example.com';
    await POST(
      makeRequest(
        { email, source: 'self_serve_landing', idempotencyKey: 'body-supplied-key-9999' },
        { 'x-idempotency-key': 'header-supplied-key-1234' },
      ),
    );
    const call = startOnboardingSession.mock.calls[0]![0] as { idempotencyKey: string };
    expect(call.idempotencyKey).toBe('body-supplied-key-9999');
  });

  it('propagates the { duplicate: true } flag from startOnboardingSession through to the response', async () => {
    startOnboardingSession.mockResolvedValueOnce({
      sessionToken: FIXED_TOKEN,
      tenantSlug: FIXED_SLUG,
      productId: null,
      clientProductId: null,
      duplicate: true,
    });
    const res = await POST(makeRequest({ email: 'dup@example.com', source: 'self_serve_landing' }));
    const { status, body } = await bodyOf(res);
    expect(status).toBe(200);
    expect(body).toEqual({
      sessionId: FIXED_TOKEN,
      tenantSlug: FIXED_SLUG,
      duplicate: true,
    });
  });

  it('500s with { error: service_unavailable } when startOnboardingSession throws', async () => {
    startOnboardingSession.mockRejectedValueOnce(new Error('database unreachable'));
    const res = await POST(makeRequest({ email: 'boom@example.com', source: 'self_serve_landing' }));
    const { status, body } = await bodyOf(res);
    expect(status).toBe(500);
    expect(body.error).toBe('service_unavailable');
    expect(body.detail).toBe('database unreachable');
  });
});
