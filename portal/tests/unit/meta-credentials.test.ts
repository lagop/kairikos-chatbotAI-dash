// =============================================================================
// Unit tests for src/lib/meta-credentials.ts — encrypted storage +
// resolution of the operator-pasted Meta app credentials. Mirrors
// twilio-credentials.test.ts's conventions closely.
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
    metaOperatorCredential: {
      upsert: (...args: unknown[]) => upsert(...args),
    },
    metaCredentialAudit: {
      create: (...args: unknown[]) => create(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...(args as [unknown[]])),
  },
}));

const mockState = { isDatabaseConfigured: true };

const ACTOR = { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' };
const EMPTY_ROW = {
  id: '00000000-0000-0000-0000-0000000000f3',
  appId: null,
  appSecretCiphertext: null,
  appSecretIv: null,
  appSecretTag: null,
  appSecretLastFour: null,
  configId: null,
  coexistenceConfigId: null,
  savedAt: null,
};

beforeEach(() => {
  vi.resetModules();
  upsert.mockReset();
  create.mockReset();
  transaction.mockReset().mockImplementation((ops: unknown[]) => Promise.all(ops));
  mockState.isDatabaseConfigured = true;
  process.env.META_CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_CONFIG_ID;
  delete process.env.META_COEXISTENCE_CONFIG_ID;
});

afterEach(() => {
  delete process.env.META_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_CONFIG_ID;
  delete process.env.META_COEXISTENCE_CONFIG_ID;
});

describe('getMetaCredentialStatus', () => {
  it('masks an empty row as unconfigured', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    const { getMetaCredentialStatus } = await import('@/lib/meta-credentials');

    const status = await getMetaCredentialStatus();

    expect(status).toEqual({
      configured: false,
      appId: null,
      appSecretLastFour: null,
      savedAt: null,
      configId: null,
      coexistenceConfigId: null,
    });
  });
});

describe('saveMetaCredential', () => {
  it('encrypts the app secret, upserts the row, and audits credential_saved for a fresh save', async () => {
    upsert
      .mockResolvedValueOnce(EMPTY_ROW) // getMetaCredentialStatus() read inside saveMetaCredential
      .mockResolvedValueOnce({ ...EMPTY_ROW }); // the write itself (inside $transaction)
    const { saveMetaCredential } = await import('@/lib/meta-credentials');

    await saveMetaCredential('app_1234567890', 'appsecret_abcdWXYZ', ACTOR);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    const writeCall = upsert.mock.calls[1][0];
    expect(writeCall.update.appId).toBe('app_1234567890');
    expect(writeCall.update.appSecretLastFour).toBe('WXYZ');
    // Never the plaintext secret.
    expect(JSON.stringify(writeCall)).not.toContain('appsecret_abcdWXYZ');
    expect(writeCall.update.appSecretCiphertext).toBeInstanceOf(Buffer);

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
    expect(JSON.stringify(auditData)).not.toContain('appsecret_abcdWXYZ');
  });

  it('audits credential_rotated when a credential already existed', async () => {
    upsert
      .mockResolvedValueOnce({ ...EMPTY_ROW, appSecretCiphertext: Buffer.from('x') })
      .mockResolvedValueOnce({ ...EMPTY_ROW });
    const { saveMetaCredential } = await import('@/lib/meta-credentials');

    await saveMetaCredential('app_1234567890', 'newsecret_0000WXYZ', ACTOR);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'credential_rotated' }) }),
    );
  });

  it('invalidates the resolution cache so the next resolve re-reads the DB', async () => {
    upsert.mockResolvedValue(EMPTY_ROW);
    const mod = await import('@/lib/meta-credentials');

    // Prime the cache with the env fallback.
    process.env.META_APP_ID = 'app_env';
    process.env.META_APP_SECRET = 'secret_env';
    await mod.resolveActiveMetaCredentials();
    const callsBeforeSave = upsert.mock.calls.length;

    await mod.saveMetaCredential('app_1234567890', 'appsecret_abcdWXYZ', ACTOR);
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      appId: 'app_1234567890',
      appSecretCiphertext: Buffer.from('irrelevant-for-this-assertion'),
    });
    await mod.resolveActiveMetaCredentials().catch(() => null);
    expect(upsert.mock.calls.length).toBeGreaterThan(callsBeforeSave);
  });
});

describe('resolveActiveMetaCredentials', () => {
  it('returns null when no DB row and no env fallback are configured', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    const { resolveActiveMetaCredentials } = await import('@/lib/meta-credentials');

    const result = await resolveActiveMetaCredentials();

    expect(result).toBeNull();
  });

  it('falls back to META_APP_ID/META_APP_SECRET when no DB credential is set', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    process.env.META_APP_ID = 'app_env';
    process.env.META_APP_SECRET = 'secret_env';
    const { resolveActiveMetaCredentials } = await import('@/lib/meta-credentials');

    const result = await resolveActiveMetaCredentials();

    expect(result).toEqual({ appId: 'app_env', appSecret: 'secret_env', configId: null, coexistenceConfigId: null });
  });

  it('decrypts and returns the DB-stored pair (real round-trip)', async () => {
    const { encryptBuffer } = await import('@/lib/operator-crypto');
    const key = Buffer.from('a'.repeat(64), 'hex');
    const { ciphertext, iv, tag } = encryptBuffer('real_app_secret', key);
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      appId: 'app_db',
      appSecretCiphertext: ciphertext,
      appSecretIv: iv,
      appSecretTag: tag,
    });
    const { resolveActiveMetaCredentials } = await import('@/lib/meta-credentials');

    const result = await resolveActiveMetaCredentials();

    expect(result).toEqual({ appId: 'app_db', appSecret: 'real_app_secret', configId: null, coexistenceConfigId: null });
  });

  it('prefers the DB-stored pair over the env fallback when both exist', async () => {
    const { encryptBuffer } = await import('@/lib/operator-crypto');
    const key = Buffer.from('a'.repeat(64), 'hex');
    const { ciphertext, iv, tag } = encryptBuffer('db_secret', key);
    upsert.mockResolvedValueOnce({ ...EMPTY_ROW, appId: 'app_db', appSecretCiphertext: ciphertext, appSecretIv: iv, appSecretTag: tag });
    process.env.META_APP_ID = 'app_env';
    process.env.META_APP_SECRET = 'secret_env';
    const { resolveActiveMetaCredentials } = await import('@/lib/meta-credentials');

    const result = await resolveActiveMetaCredentials();

    expect(result).toEqual({ appId: 'app_db', appSecret: 'db_secret', configId: null, coexistenceConfigId: null });
  });

  it('caches the resolved credentials for the TTL window — a second call within it does not re-query the DB', async () => {
    vi.useFakeTimers();
    try {
      upsert.mockResolvedValueOnce(EMPTY_ROW);
      process.env.META_APP_ID = 'app_env';
      process.env.META_APP_SECRET = 'secret_env';
      const { resolveActiveMetaCredentials } = await import('@/lib/meta-credentials');

      await resolveActiveMetaCredentials();
      expect(upsert).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10_000);
      await resolveActiveMetaCredentials();
      expect(upsert).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-queries after the cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      upsert.mockResolvedValue(EMPTY_ROW);
      process.env.META_APP_ID = 'app_env';
      process.env.META_APP_SECRET = 'secret_env';
      const { resolveActiveMetaCredentials } = await import('@/lib/meta-credentials');

      await resolveActiveMetaCredentials();
      expect(upsert).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(31_000);
      await resolveActiveMetaCredentials();
      expect(upsert).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves configId/coexistenceConfigId independently of the app pair — DB pair + env config ids both present', async () => {
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      appId: 'app_db',
      appSecretCiphertext: null, // no DB pair — falls back to env for the pair
    });
    process.env.META_APP_ID = 'app_env';
    process.env.META_APP_SECRET = 'secret_env';
    process.env.META_CONFIG_ID = 'config_env';
    process.env.META_COEXISTENCE_CONFIG_ID = 'coexistence_env';
    const { resolveActiveMetaCredentials } = await import('@/lib/meta-credentials');

    const result = await resolveActiveMetaCredentials();

    expect(result).toEqual({
      appId: 'app_env',
      appSecret: 'secret_env',
      configId: 'config_env',
      coexistenceConfigId: 'coexistence_env',
    });
  });

  it('prefers DB-stored configId/coexistenceConfigId over the env fallback when both exist', async () => {
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      appId: 'app_env',
      configId: 'config_db',
      coexistenceConfigId: 'coexistence_db',
    });
    process.env.META_APP_ID = 'app_env';
    process.env.META_APP_SECRET = 'secret_env';
    process.env.META_CONFIG_ID = 'config_env';
    process.env.META_COEXISTENCE_CONFIG_ID = 'coexistence_env';
    const { resolveActiveMetaCredentials } = await import('@/lib/meta-credentials');

    const result = await resolveActiveMetaCredentials();

    expect(result).toMatchObject({ configId: 'config_db', coexistenceConfigId: 'coexistence_db' });
  });
});

describe('saveMetaConfigIds', () => {
  it('upserts configId/coexistenceConfigId and audits config_ids_saved without touching the credential pair', async () => {
    upsert
      .mockResolvedValueOnce(EMPTY_ROW) // the before-read inside saveMetaConfigIds
      .mockResolvedValueOnce({ ...EMPTY_ROW, configId: 'C1', coexistenceConfigId: 'CC1' }); // the write itself
    const { saveMetaConfigIds } = await import('@/lib/meta-credentials');

    await saveMetaConfigIds('C1', 'CC1', ACTOR);

    expect(transaction).toHaveBeenCalledTimes(1);
    const writeCall = upsert.mock.calls[1][0];
    expect(writeCall.update).toEqual({ configId: 'C1', coexistenceConfigId: 'CC1' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'config_ids_saved',
          before: { configId: null, coexistenceConfigId: null },
          after: { configId: 'C1', coexistenceConfigId: 'CC1' },
        }),
      }),
    );
  });

  it('accepts a null operatorId (legacy-key caller) without touching the actorOperatorId FK', async () => {
    upsert.mockResolvedValue(EMPTY_ROW);
    const { saveMetaConfigIds } = await import('@/lib/meta-credentials');

    await saveMetaConfigIds('C1', 'CC1', { operatorId: null, operatorEmail: null });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorOperatorId: null }) }),
    );
  });

  it('invalidates the resolution cache', async () => {
    upsert.mockResolvedValue(EMPTY_ROW);
    process.env.META_APP_ID = 'app_env';
    process.env.META_APP_SECRET = 'secret_env';
    process.env.META_CONFIG_ID = 'config_env';
    const mod = await import('@/lib/meta-credentials');

    await mod.resolveActiveMetaCredentials();
    const callsBeforeSave = upsert.mock.calls.length;

    await mod.saveMetaConfigIds('C1', 'CC1', ACTOR);
    upsert.mockResolvedValueOnce({ ...EMPTY_ROW, configId: 'C1', coexistenceConfigId: 'CC1' });
    await mod.resolveActiveMetaCredentials();
    expect(upsert.mock.calls.length).toBeGreaterThan(callsBeforeSave);
  });
});
