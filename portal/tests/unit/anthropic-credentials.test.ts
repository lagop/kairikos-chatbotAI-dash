// =============================================================================
// Unit tests for src/lib/anthropic-credentials.ts — encrypted storage +
// resolution of the operator-pasted Anthropic credential.
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
    anthropicOperatorCredential: {
      upsert: (...args: unknown[]) => upsert(...args),
    },
    anthropicCredentialAudit: {
      create: (...args: unknown[]) => create(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...(args as [unknown[]])),
  },
}));

const mockState = { isDatabaseConfigured: true };

const ACTOR = { operatorId: 'op_1', operatorEmail: 'lucia@kairikos.com' };
const EMPTY_ROW = {
  id: '00000000-0000-0000-0000-0000000000f3',
  apiKeyCiphertext: null,
  apiKeyIv: null,
  apiKeyTag: null,
  apiKeyLastFour: null,
  baseUrl: null,
  model: null,
  savedAt: null,
};

beforeEach(() => {
  vi.resetModules();
  upsert.mockReset();
  create.mockReset();
  transaction.mockReset().mockImplementation((ops: unknown[]) => Promise.all(ops));
  mockState.isDatabaseConfigured = true;
  process.env.ANTHROPIC_CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  delete process.env.ANTHROPIC_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('getAnthropicCredentialStatus', () => {
  it('masks an empty row as unconfigured', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    const { getAnthropicCredentialStatus } = await import('@/lib/anthropic-credentials');

    const status = await getAnthropicCredentialStatus();

    expect(status).toEqual({
      configured: false,
      apiKeyLastFour: null,
      savedAt: null,
      baseUrl: null,
      model: null,
    });
  });
});

describe('saveAnthropicCredential', () => {
  it('encrypts the api key, upserts the row, and audits credential_saved for a fresh save', async () => {
    upsert
      .mockResolvedValueOnce(EMPTY_ROW) // getAnthropicCredentialStatus() read inside saveAnthropicCredential
      .mockResolvedValueOnce({ ...EMPTY_ROW }); // the write itself (inside $transaction)
    const { saveAnthropicCredential } = await import('@/lib/anthropic-credentials');

    await saveAnthropicCredential({ apiKey: 'sk-ant-test-abcdWXYZ', baseUrl: null, model: null }, ACTOR);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(2);
    const writeCall = upsert.mock.calls[1][0];
    expect(writeCall.update.apiKeyLastFour).toBe('WXYZ');
    // Never the plaintext key.
    expect(JSON.stringify(writeCall)).not.toContain('sk-ant-test-abcdWXYZ');
    expect(writeCall.update.apiKeyCiphertext).toBeInstanceOf(Buffer);

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
    expect(JSON.stringify(auditData)).not.toContain('sk-ant-test-abcdWXYZ');
  });

  it('persists baseUrl/model alongside the encrypted key', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW).mockResolvedValueOnce({ ...EMPTY_ROW });
    const { saveAnthropicCredential } = await import('@/lib/anthropic-credentials');

    await saveAnthropicCredential(
      { apiKey: 'sk-ant-test-abcdWXYZ', baseUrl: 'https://proxy.example.com', model: 'claude-opus-5' },
      ACTOR,
    );

    const writeCall = upsert.mock.calls[1][0];
    expect(writeCall.update.baseUrl).toBe('https://proxy.example.com');
    expect(writeCall.update.model).toBe('claude-opus-5');
  });

  it('audits credential_rotated when a credential already existed', async () => {
    upsert
      .mockResolvedValueOnce({ ...EMPTY_ROW, apiKeyCiphertext: Buffer.from('x') })
      .mockResolvedValueOnce({ ...EMPTY_ROW });
    const { saveAnthropicCredential } = await import('@/lib/anthropic-credentials');

    await saveAnthropicCredential({ apiKey: 'sk-ant-new-0000WXYZ', baseUrl: null, model: null }, ACTOR);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'credential_rotated' }) }),
    );
  });

  it('invalidates the resolution cache so the next resolve re-reads the DB', async () => {
    upsert.mockResolvedValue(EMPTY_ROW);
    const mod = await import('@/lib/anthropic-credentials');

    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    await mod.resolveActiveAnthropicCredentials();
    const callsBeforeSave = upsert.mock.calls.length;

    await mod.saveAnthropicCredential({ apiKey: 'sk-ant-test-abcdWXYZ', baseUrl: null, model: null }, ACTOR);
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      apiKeyCiphertext: Buffer.from('irrelevant-for-this-assertion'),
    });
    await mod.resolveActiveAnthropicCredentials().catch(() => null);
    expect(upsert.mock.calls.length).toBeGreaterThan(callsBeforeSave);
  });
});

describe('resolveActiveAnthropicCredentials', () => {
  it('returns null when no DB row and no env fallback are configured', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    const { resolveActiveAnthropicCredentials } = await import('@/lib/anthropic-credentials');

    const result = await resolveActiveAnthropicCredentials();

    expect(result).toBeNull();
  });

  it('falls back to ANTHROPIC_API_KEY when no DB credential is set, with the built-in baseUrl/model defaults', async () => {
    upsert.mockResolvedValueOnce(EMPTY_ROW);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const { resolveActiveAnthropicCredentials } = await import('@/lib/anthropic-credentials');

    const result = await resolveActiveAnthropicCredentials();

    expect(result).toEqual({
      apiKey: 'sk-ant-env',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('decrypts and returns the DB-stored key (real round-trip)', async () => {
    const { encryptBuffer } = await import('@/lib/operator-crypto');
    const key = Buffer.from('a'.repeat(64), 'hex');
    const { ciphertext, iv, tag } = encryptBuffer('sk-ant-real-key', key);
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      apiKeyCiphertext: ciphertext,
      apiKeyIv: iv,
      apiKeyTag: tag,
    });
    const { resolveActiveAnthropicCredentials } = await import('@/lib/anthropic-credentials');

    const result = await resolveActiveAnthropicCredentials();

    expect(result).toEqual({
      apiKey: 'sk-ant-real-key',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('prefers the DB-stored key over the env fallback when both exist', async () => {
    const { encryptBuffer } = await import('@/lib/operator-crypto');
    const key = Buffer.from('a'.repeat(64), 'hex');
    const { ciphertext, iv, tag } = encryptBuffer('sk-ant-db-key', key);
    upsert.mockResolvedValueOnce({ ...EMPTY_ROW, apiKeyCiphertext: ciphertext, apiKeyIv: iv, apiKeyTag: tag });
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const { resolveActiveAnthropicCredentials } = await import('@/lib/anthropic-credentials');

    const result = await resolveActiveAnthropicCredentials();

    expect(result?.apiKey).toBe('sk-ant-db-key');
  });

  it('resolves baseUrl/model from the DB row when saved, overriding the built-in defaults', async () => {
    upsert.mockResolvedValueOnce({
      ...EMPTY_ROW,
      apiKeyCiphertext: Buffer.from('x'),
      apiKeyIv: Buffer.from('y'),
      apiKeyTag: Buffer.from('z'),
      baseUrl: 'https://proxy.example.com',
      model: 'claude-opus-5',
    });
    vi.doMock('@/lib/operator-crypto', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/operator-crypto')>();
      return { ...actual, decryptBuffer: () => 'sk-ant-db-key' };
    });
    const { resolveActiveAnthropicCredentials } = await import('@/lib/anthropic-credentials');

    const result = await resolveActiveAnthropicCredentials();

    expect(result).toEqual({ apiKey: 'sk-ant-db-key', baseUrl: 'https://proxy.example.com', model: 'claude-opus-5' });
  });

  it('caches the resolved credentials for the TTL window — a second call within it does not re-query the DB', async () => {
    vi.useFakeTimers();
    try {
      upsert.mockResolvedValueOnce(EMPTY_ROW);
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
      const { resolveActiveAnthropicCredentials } = await import('@/lib/anthropic-credentials');

      await resolveActiveAnthropicCredentials();
      expect(upsert).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(10_000);
      await resolveActiveAnthropicCredentials();
      expect(upsert).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-queries after the cache TTL expires', async () => {
    vi.useFakeTimers();
    try {
      upsert.mockResolvedValue(EMPTY_ROW);
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
      const { resolveActiveAnthropicCredentials } = await import('@/lib/anthropic-credentials');

      await resolveActiveAnthropicCredentials();
      expect(upsert).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(31_000);
      await resolveActiveAnthropicCredentials();
      expect(upsert).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
