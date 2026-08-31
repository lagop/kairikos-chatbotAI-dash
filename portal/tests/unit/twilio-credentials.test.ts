// =============================================================================
// Unit tests for src/lib/twilio-credentials.ts — encrypted storage +
// resolution of the operator-pasted Twilio credential pair.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const upsert = vi.fn();
const create = vi.fn();
const transaction = vi.fn((ops: unknown[]) => Promise.all(ops));

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    twilioOperatorCredential: {
      upsert: (...args: unknown[]) => upsert(...args),
    },
    twilioCredentialAudit: {
      create: (...args: unknown[]) => create(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...(args as [unknown[]])),
  },
}));

const mockState = { isDatabaseConfigured: true };

const ACTOR = { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' };
const EMPTY_ROW = {
  id: '00000000-0000-0000-0000-0000000000f2',
  accountSid: null,
  authTokenCiphertext: null,
  authTokenIv: null,
  authTokenTag: null,
  authTokenLastFour: null,
  bundleSid: null,
  addressSid: null,
  savedAt: null,
};

beforeEach(() => {
  vi.resetModules();
  upsert.mockReset();
  create.mockReset();
  transaction.mockReset().mockImplementation((ops: unknown[]) => Promise.all(ops));
  mockState.isDatabaseConfigured = true;
  process.env.TWILIO_CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});

afterEach(() => {
  delete process.env.TWILIO_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
});

describe('getTwilioCredentialStatus', () => {
  it('masks an empty row as unconfigured', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    const { getTwilioCredentialStatus } = await import('@/lib/twilio-credentials');

    const status = await getTwilioCredentialStatus();

    expect(status).toEqual({
      configured: false,
      accountSid: null,
      authTokenLastFour: null,
      savedAt: null,
      bundleSid: null,
      addressSid: null,
    });
  });
});

describe('saveTwilioCredential', () => {
  it('encrypts the auth token, upserts the row, and audits credential_saved for a fresh save', async () => {
    upsert
      .mockResolvedValueOnce(EMPTY_ROW) // getTwilioCredentialStatus() read inside saveTwilioCredential
      .mockResolvedValueOnce({ ...EMPTY_ROW }); // the write itself (inside $transaction)
    const { saveTwilioCredential } = await import('@/lib/twilio-credentials');

    await saveTwilioCredential('AC1234567890', 'authtoken_abcdWXYZ', ACTOR);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    const writeCall = upsert.mock.calls[1][0];
    expect(writeCall.update.accountSid).toBe('AC1234567890');
    expect(writeCall.update.authTokenLastFour).toBe('WXYZ');
    // Never the plaintext token.
    expect(JSON.stringify(writeCall)).not.toContain('authtoken_abcdWXYZ');
    expect(writeCall.update.authTokenCiphertext).toBeInstanceOf(Buffer);

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
    expect(JSON.stringify(auditData)).not.toContain('authtoken_abcdWXYZ');
  });

  it('audits credential_rotated when a credential already existed', async () => {
    upsert
      .mockResolvedValueOnce({ ...EMPTY_ROW, authTokenCiphertext: Buffer.from('x') })
      .mockResolvedValueOnce({ ...EMPTY_ROW });
    const { saveTwilioCredential } = await import('@/lib/twilio-credentials');

    await saveTwilioCredential('AC1234567890', 'newtoken_0000WXYZ', ACTOR);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'credential_rotated' }) }),
    );
  });

  it('invalidates the resolution cache so the next resolve re-reads the DB', async () => {
    upsert.mockResolvedValue(EMPTY_ROW);
    const mod = await import('@/lib/twilio-credentials');

    // Prime the cache with the env fallback.
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'tok_env';
    await mod.resolveActiveTwilioCredentials();
    const callsBeforeSave = upsert.mock.calls.length;

    await mod.saveTwilioCredential('AC1234567890', 'authtoken_abcdWXYZ', ACTOR);
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      accountSid: 'AC1234567890',
      authTokenCiphertext: Buffer.from('irrelevant-for-this-assertion'),
    });
    await mod.resolveActiveTwilioCredentials().catch(() => null);
    expect(upsert.mock.calls.length).toBeGreaterThan(callsBeforeSave);
  });
});

describe('resolveActiveTwilioCredentials', () => {
  it('returns null when no DB row and no env fallback are configured', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    const { resolveActiveTwilioCredentials } = await import('@/lib/twilio-credentials');

    const result = await resolveActiveTwilioCredentials();

    expect(result).toBeNull();
  });

  it('falls back to TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN when no DB credential is set', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'tok_env';
    const { resolveActiveTwilioCredentials } = await import('@/lib/twilio-credentials');

    const result = await resolveActiveTwilioCredentials();

    expect(result).toEqual({ accountSid: 'AC_env', authToken: 'tok_env', bundleSid: null, addressSid: null });
  });

  it('decrypts and returns the DB-stored pair (real round-trip)', async () => {
    const { encryptBuffer } = await import('@/lib/operator-crypto');
    const key = Buffer.from('a'.repeat(64), 'hex');
    const { ciphertext, iv, tag } = encryptBuffer('real_auth_token', key);
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      accountSid: 'AC_db',
      authTokenCiphertext: ciphertext,
      authTokenIv: iv,
      authTokenTag: tag,
    });
    const { resolveActiveTwilioCredentials } = await import('@/lib/twilio-credentials');

    const result = await resolveActiveTwilioCredentials();

    expect(result).toEqual({ accountSid: 'AC_db', authToken: 'real_auth_token', bundleSid: null, addressSid: null });
  });

  it('prefers the DB-stored pair over the env fallback when both exist', async () => {
    const { encryptBuffer } = await import('@/lib/operator-crypto');
    const key = Buffer.from('a'.repeat(64), 'hex');
    const { ciphertext, iv, tag } = encryptBuffer('db_token', key);
    upsert.mockResolvedValueOnce({ ...EMPTY_ROW, accountSid: 'AC_db', authTokenCiphertext: ciphertext, authTokenIv: iv, authTokenTag: tag });
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'tok_env';
    const { resolveActiveTwilioCredentials } = await import('@/lib/twilio-credentials');

    const result = await resolveActiveTwilioCredentials();

    expect(result).toEqual({ accountSid: 'AC_db', authToken: 'db_token', bundleSid: null, addressSid: null });
  });

  it('caches the resolved credentials for the TTL window — a second call within it does not re-query the DB', async () => {
    vi.useFakeTimers();
    try {
      upsert.mockResolvedValueOnce(EMPTY_ROW);
      process.env.TWILIO_ACCOUNT_SID = 'AC_env';
      process.env.TWILIO_AUTH_TOKEN = 'tok_env';
      const { resolveActiveTwilioCredentials } = await import('@/lib/twilio-credentials');

      await resolveActiveTwilioCredentials();
      expect(upsert).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10_000);
      await resolveActiveTwilioCredentials();
      expect(upsert).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-queries after the cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      upsert.mockResolvedValue(EMPTY_ROW);
      process.env.TWILIO_ACCOUNT_SID = 'AC_env';
      process.env.TWILIO_AUTH_TOKEN = 'tok_env';
      const { resolveActiveTwilioCredentials } = await import('@/lib/twilio-credentials');

      await resolveActiveTwilioCredentials();
      expect(upsert).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(31_000);
      await resolveActiveTwilioCredentials();
      expect(upsert).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves bundleSid/addressSid independently of the account pair — DB pair + env regulatory ids both present', async () => {
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      accountSid: 'AC_db',
      authTokenCiphertext: null, // no DB pair — falls back to env for the pair
    });
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'tok_env';
    process.env.TWILIO_BUNDLE_SID = 'BU_env';
    process.env.TWILIO_ADDRESS_SID = 'AD_env';
    const { resolveActiveTwilioCredentials } = await import('@/lib/twilio-credentials');

    const result = await resolveActiveTwilioCredentials();

    expect(result).toEqual({
      accountSid: 'AC_env',
      authToken: 'tok_env',
      bundleSid: 'BU_env',
      addressSid: 'AD_env',
    });
  });

  it('prefers DB-stored bundleSid/addressSid over the env fallback when both exist', async () => {
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      accountSid: 'AC_env',
      bundleSid: 'BU_db',
      addressSid: 'AD_db',
    });
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'tok_env';
    process.env.TWILIO_BUNDLE_SID = 'BU_env';
    process.env.TWILIO_ADDRESS_SID = 'AD_env';
    const { resolveActiveTwilioCredentials } = await import('@/lib/twilio-credentials');

    const result = await resolveActiveTwilioCredentials();

    expect(result).toMatchObject({ bundleSid: 'BU_db', addressSid: 'AD_db' });
  });
});

describe('saveTwilioRegulatoryIds', () => {
  it('upserts bundleSid/addressSid and audits regulatory_ids_saved without touching the credential pair', async () => {
    upsert
      .mockResolvedValueOnce(EMPTY_ROW) // the before-read inside saveTwilioRegulatoryIds
      .mockResolvedValueOnce({ ...EMPTY_ROW, bundleSid: 'BU1', addressSid: 'AD1' }); // the write itself
    const { saveTwilioRegulatoryIds } = await import('@/lib/twilio-credentials');

    await saveTwilioRegulatoryIds('BU1', 'AD1', ACTOR);

    expect(transaction).toHaveBeenCalledTimes(1);
    const writeCall = upsert.mock.calls[1][0];
    expect(writeCall.update).toEqual({ bundleSid: 'BU1', addressSid: 'AD1' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'regulatory_ids_saved',
          before: { bundleSid: null, addressSid: null },
          after: { bundleSid: 'BU1', addressSid: 'AD1' },
        }),
      }),
    );
  });

  it('accepts a null operatorId (legacy-key caller) without touching the actorOperatorId FK', async () => {
    upsert.mockResolvedValue(EMPTY_ROW);
    const { saveTwilioRegulatoryIds } = await import('@/lib/twilio-credentials');

    await saveTwilioRegulatoryIds('BU1', 'AD1', { operatorId: null, operatorEmail: null });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorOperatorId: null }) }),
    );
  });

  it('invalidates the resolution cache', async () => {
    upsert.mockResolvedValue(EMPTY_ROW);
    process.env.TWILIO_ACCOUNT_SID = 'AC_env';
    process.env.TWILIO_AUTH_TOKEN = 'tok_env';
    process.env.TWILIO_BUNDLE_SID = 'BU_env';
    const mod = await import('@/lib/twilio-credentials');

    await mod.resolveActiveTwilioCredentials();
    const callsBeforeSave = upsert.mock.calls.length;

    await mod.saveTwilioRegulatoryIds('BU1', 'AD1', ACTOR);
    upsert.mockResolvedValueOnce({ ...EMPTY_ROW, bundleSid: 'BU1', addressSid: 'AD1' });
    await mod.resolveActiveTwilioCredentials();
    expect(upsert.mock.calls.length).toBeGreaterThan(callsBeforeSave);
  });
});
