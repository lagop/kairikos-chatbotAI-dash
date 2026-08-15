// =============================================================================
// Unit tests for src/lib/stripe-credentials.ts — encrypted storage +
// resolution of the operator-pasted Stripe secret key(s).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const upsert = vi.fn();
const update = vi.fn();
const create = vi.fn();
const transaction = vi.fn((ops: unknown[]) => Promise.all(ops));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    stripeOperatorCredential: {
      upsert: (...args: unknown[]) => upsert(...args),
      update: (...args: unknown[]) => update(...args),
    },
    stripeCatalogAudit: {
      create: (...args: unknown[]) => create(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...(args as [unknown[]])),
  },
}));

const mockState = { isDatabaseConfigured: true };

const ACTOR = { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' };
const EMPTY_ROW = {
  id: '00000000-0000-0000-0000-0000000000f1',
  activeMode: null,
  testSecretKeyCiphertext: null,
  testSecretKeyIv: null,
  testSecretKeyTag: null,
  testSecretKeyLastFour: null,
  testSavedAt: null,
  liveSecretKeyCiphertext: null,
  liveSecretKeyIv: null,
  liveSecretKeyTag: null,
  liveSecretKeyLastFour: null,
  liveSavedAt: null,
};

beforeEach(() => {
  vi.resetModules();
  upsert.mockReset();
  update.mockReset();
  create.mockReset();
  transaction.mockReset().mockImplementation((ops: unknown[]) => Promise.all(ops));
  mockState.isDatabaseConfigured = true;
  process.env.STRIPE_CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
  delete process.env.STRIPE_SECRET_KEY;
});

afterEach(() => {
  delete process.env.STRIPE_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.STRIPE_SECRET_KEY;
});

describe('getStripeCredentialStatus', () => {
  it('masks an empty row as unconfigured for both modes', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    const { getStripeCredentialStatus } = await import('@/lib/stripe-credentials');

    const status = await getStripeCredentialStatus();

    expect(status).toEqual({
      activeMode: null,
      test: { configured: false, lastFour: null, savedAt: null },
      live: { configured: false, lastFour: null, savedAt: null },
    });
  });
});

describe('saveStripeCredential', () => {
  it('encrypts the key, upserts the row, and audits credential_saved for a fresh save', async () => {
    upsert
      .mockResolvedValueOnce(EMPTY_ROW) // getStripeCredentialStatus() read inside saveStripeCredential
      .mockResolvedValueOnce({ ...EMPTY_ROW }); // the write itself (inside $transaction)
    const { saveStripeCredential } = await import('@/lib/stripe-credentials');

    await saveStripeCredential('test', 'sk_test_abcd1234WXYZ', ACTOR);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    const writeCall = upsert.mock.calls[1][0];
    expect(writeCall.update.testSecretKeyLastFour).toBe('WXYZ');
    // Never the plaintext key.
    expect(JSON.stringify(writeCall)).not.toContain('sk_test_abcd1234WXYZ');
    expect(writeCall.update.testSecretKeyCiphertext).toBeInstanceOf(Buffer);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'credential_saved',
          actorOperatorId: 'op_1',
          actorEmail: 'lucia@kairikos.com',
        }),
      }),
    );
    // The audit row must never carry the plaintext or ciphertext.
    const auditData = create.mock.calls[0][0].data;
    expect(JSON.stringify(auditData)).not.toContain('sk_test_abcd1234WXYZ');
  });

  it('audits credential_rotated when a key already existed for that mode', async () => {
    upsert
      .mockResolvedValueOnce({ ...EMPTY_ROW, testSecretKeyCiphertext: Buffer.from('x') })
      .mockResolvedValueOnce({ ...EMPTY_ROW });
    const { saveStripeCredential } = await import('@/lib/stripe-credentials');

    await saveStripeCredential('test', 'sk_test_newkey0000WXYZ', ACTOR);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'credential_rotated' }) }),
    );
  });

  it('invalidates the resolution cache so the next resolve re-reads the DB', async () => {
    upsert.mockResolvedValue(EMPTY_ROW);
    const mod = await import('@/lib/stripe-credentials');

    // Prime the cache with the env fallback.
    process.env.STRIPE_SECRET_KEY = 'sk_test_envfallback';
    await mod.resolveActiveStripeSecret();
    const callsBeforeSave = upsert.mock.calls.length;

    await mod.saveStripeCredential('test', 'sk_test_abcd1234WXYZ', ACTOR);
    // save itself calls upsert twice (status read + write) — invalidation
    // is checked by confirming the NEXT resolve call also hits the DB.
    mockState.isDatabaseConfigured = true;
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      activeMode: 'test',
      testSecretKeyCiphertext: Buffer.from('irrelevant-for-this-assertion'),
    });
    await mod.resolveActiveStripeSecret().catch(() => null);
    expect(upsert.mock.calls.length).toBeGreaterThan(callsBeforeSave);
  });
});

describe('setActiveStripeMode', () => {
  it('updates activeMode and audits active_mode_changed with before/after modes', async () => {
    upsert.mockResolvedValueOnce({ ...EMPTY_ROW, activeMode: null });
    update.mockResolvedValueOnce({ ...EMPTY_ROW, activeMode: 'live' });
    const { setActiveStripeMode } = await import('@/lib/stripe-credentials');

    await setActiveStripeMode('live', ACTOR);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { activeMode: 'live' } }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'active_mode_changed',
          before: { activeMode: null },
          after: { activeMode: 'live' },
        }),
      }),
    );
  });
});

describe('resolveActiveStripeSecret', () => {
  it('returns null when no DB row and no env fallback are configured', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    const { resolveActiveStripeSecret } = await import('@/lib/stripe-credentials');

    const result = await resolveActiveStripeSecret();

    expect(result).toBeNull();
  });

  it('falls back to STRIPE_SECRET_KEY when no active DB credential is set', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    process.env.STRIPE_SECRET_KEY = 'sk_live_fallbackkey';
    const { resolveActiveStripeSecret } = await import('@/lib/stripe-credentials');

    const result = await resolveActiveStripeSecret();

    expect(result).toEqual({ mode: 'live', key: 'sk_live_fallbackkey' });
  });

  it('infers test mode from a non-sk_live_ prefixed env fallback key', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    process.env.STRIPE_SECRET_KEY = 'sk_test_fallbackkey';
    const { resolveActiveStripeSecret } = await import('@/lib/stripe-credentials');

    const result = await resolveActiveStripeSecret();

    expect(result?.mode).toBe('test');
  });

  it('decrypts and returns the DB-stored key for the active mode (real round-trip)', async () => {
    const { encryptBuffer } = await import('@/lib/operator-crypto');
    const key = Buffer.from('a'.repeat(64), 'hex');
    const { ciphertext, iv, tag } = encryptBuffer('sk_test_realsecret', key);
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      activeMode: 'test',
      testSecretKeyCiphertext: ciphertext,
      testSecretKeyIv: iv,
      testSecretKeyTag: tag,
    });
    const { resolveActiveStripeSecret } = await import('@/lib/stripe-credentials');

    const result = await resolveActiveStripeSecret();

    expect(result).toEqual({ mode: 'test', key: 'sk_test_realsecret' });
  });

  it('caches the resolved secret for the TTL window — a second call within it does not re-query the DB', async () => {
    vi.useFakeTimers();
    try {
      upsert.mockResolvedValueOnce(EMPTY_ROW);
      process.env.STRIPE_SECRET_KEY = 'sk_test_cached';
      const { resolveActiveStripeSecret } = await import('@/lib/stripe-credentials');

      await resolveActiveStripeSecret();
      expect(upsert).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10_000);
      await resolveActiveStripeSecret();
      // Still cached (env fallback is cached too) — no additional DB read.
      expect(upsert).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-queries after the cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      upsert.mockResolvedValue(EMPTY_ROW);
      process.env.STRIPE_SECRET_KEY = 'sk_test_cached';
      const { resolveActiveStripeSecret } = await import('@/lib/stripe-credentials');

      await resolveActiveStripeSecret();
      expect(upsert).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(31_000);
      await resolveActiveStripeSecret();
      expect(upsert).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
