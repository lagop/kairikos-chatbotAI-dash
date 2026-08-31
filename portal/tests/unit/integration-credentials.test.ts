// =============================================================================
// Unit tests for src/lib/integration-credentials.ts — the generic
// encrypted-in-DB credential store behind /admin/portal/settings/integrations.
// Same mocking conventions as stripe-credentials.test.ts, where it exists.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  isDatabaseConfigured: true,
  credentialFindUnique: vi.fn(),
  credentialUpsert: vi.fn(),
  auditCreate: vi.fn(),
  encryptBuffer: vi.fn(),
  decryptBuffer: vi.fn(),
  parseHexKey: vi.fn(),
}));

const mockTx = {
  integrationCredential: { upsert: (...a: unknown[]) => mockState.credentialUpsert(...a) },
  integrationCredentialAudit: { create: (...a: unknown[]) => mockState.auditCreate(...a) },
};

vi.mock('@/lib/prisma', () => ({
  get isDatabaseConfigured() {
    return mockState.isDatabaseConfigured;
  },
  prisma: {
    integrationCredential: { findUnique: (...a: unknown[]) => mockState.credentialFindUnique(...a) },
    $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  },
}));

vi.mock('@/lib/operator-crypto', () => ({
  encryptBuffer: (...a: unknown[]) => mockState.encryptBuffer(...a),
  decryptBuffer: (...a: unknown[]) => mockState.decryptBuffer(...a),
  parseHexKey: (...a: unknown[]) => mockState.parseHexKey(...a),
}));

import {
  getIntegrationCredentialStatus,
  saveIntegrationCredential,
  resolveIntegrationSecret,
  resolveIntegrationClientId,
  invalidateIntegrationCredentialCache,
} from '@/lib/integration-credentials';

const ACTOR = { operatorId: 'op_1', operatorEmail: 'op@kairikos.com' };
const CIPHER = { ciphertext: Buffer.from('c'), iv: Buffer.from('i'), tag: Buffer.from('t') };

beforeEach(() => {
  mockState.isDatabaseConfigured = true;
  mockState.credentialFindUnique.mockReset().mockResolvedValue(null);
  mockState.credentialUpsert.mockReset().mockImplementation(({ create }: { create: Record<string, unknown> }) =>
    Promise.resolve({ id: 'cred_1', ...create }),
  );
  mockState.auditCreate.mockReset();
  mockState.encryptBuffer.mockReset().mockReturnValue(CIPHER);
  mockState.decryptBuffer.mockReset().mockReturnValue('decrypted_secret');
  mockState.parseHexKey.mockReset().mockReturnValue(Buffer.from('k'));
  invalidateIntegrationCredentialCache('google_places');
  invalidateIntegrationCredentialCache('google_business');
  invalidateIntegrationCredentialCache('some_other_tool');
});

describe('getIntegrationCredentialStatus', () => {
  it('not configured when no row exists for this toolKey', async () => {
    const status = await getIntegrationCredentialStatus('google_places');
    expect(status).toEqual({ configured: false, lastFour: null, savedAt: null, clientId: null });
  });

  it('configured, with lastFour and savedAt, when a row exists — never decrypts', async () => {
    mockState.credentialFindUnique.mockResolvedValue({
      secretLastFour: 'wxyz',
      savedAt: new Date('2026-09-06T00:00:00.000Z'),
      clientId: null,
    });
    const status = await getIntegrationCredentialStatus('google_places');
    expect(status).toEqual({ configured: true, lastFour: 'wxyz', savedAt: '2026-09-06T00:00:00.000Z', clientId: null });
    expect(mockState.decryptBuffer).not.toHaveBeenCalled();
  });

  it('includes the cleartext clientId for an OAuth-client-style tool', async () => {
    mockState.credentialFindUnique.mockResolvedValue({
      secretLastFour: 'wxyz',
      savedAt: new Date('2026-09-06T00:00:00.000Z'),
      clientId: '123-abc.apps.googleusercontent.com',
    });
    const status = await getIntegrationCredentialStatus('google_business');
    expect(status.clientId).toBe('123-abc.apps.googleusercontent.com');
  });
});

describe('saveIntegrationCredential', () => {
  it('creates a new row and audits "credential_saved" when none existed', async () => {
    await saveIntegrationCredential('google_places', 'Google Places', 'AIzaBrandNewKey', ACTOR);

    expect(mockState.credentialUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { toolKey: 'google_places' },
        create: expect.objectContaining({
          toolKey: 'google_places',
          displayName: 'Google Places',
          secretLastFour: 'wKey',
        }),
      }),
    );
    expect(mockState.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          credentialId: 'cred_1',
          toolKey: 'google_places',
          action: 'credential_saved',
          actorOperatorId: 'op_1',
          actorEmail: 'op@kairikos.com',
        }),
      }),
    );
  });

  it('audits "credential_rotated" when a row already existed — never logs the old or new secret', async () => {
    mockState.credentialFindUnique.mockResolvedValue({ secretLastFour: 'oldK', clientId: null });
    await saveIntegrationCredential('google_places', 'Google Places', 'AIzaReplacementKey', ACTOR);

    const auditCall = mockState.auditCreate.mock.calls[0][0].data;
    expect(auditCall.action).toBe('credential_rotated');
    expect(auditCall.before).toEqual({ configured: true, lastFour: 'oldK', clientId: null });
    expect(JSON.stringify(auditCall)).not.toContain('AIzaReplacementKey');
  });

  it('stores the cleartext clientId for an OAuth-client-style tool and audits it in full (not a secret)', async () => {
    await saveIntegrationCredential(
      'google_business',
      'Google Business',
      'gocspx-real-secret-value',
      ACTOR,
      '123-abc.apps.googleusercontent.com',
    );

    expect(mockState.credentialUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ clientId: '123-abc.apps.googleusercontent.com' }),
        update: expect.objectContaining({ clientId: '123-abc.apps.googleusercontent.com' }),
      }),
    );
    const auditCall = mockState.auditCreate.mock.calls[0][0].data;
    expect(auditCall.after).toEqual({ configured: true, lastFour: 'alue', clientId: '123-abc.apps.googleusercontent.com' });
  });

  it('stores a null clientId for a plain single-secret tool', async () => {
    await saveIntegrationCredential('google_places', 'Google Places', 'AIzaBrandNewKey', ACTOR);
    expect(mockState.credentialUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ clientId: null }) }),
    );
  });
});

describe('resolveIntegrationSecret', () => {
  it('returns null when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    expect(await resolveIntegrationSecret('google_places')).toBeNull();
    expect(mockState.credentialFindUnique).not.toHaveBeenCalled();
  });

  it('returns null when no credential row exists for this toolKey', async () => {
    expect(await resolveIntegrationSecret('google_places')).toBeNull();
  });

  it('decrypts and returns the stored secret when a row exists', async () => {
    mockState.credentialFindUnique.mockResolvedValue({
      secretCiphertext: CIPHER.ciphertext,
      secretIv: CIPHER.iv,
      secretTag: CIPHER.tag,
    });
    const secret = await resolveIntegrationSecret('google_places');
    expect(secret).toBe('decrypted_secret');
  });

  it('caches the resolved secret — a second call within the TTL does not hit the DB again', async () => {
    mockState.credentialFindUnique.mockResolvedValue({
      secretCiphertext: CIPHER.ciphertext,
      secretIv: CIPHER.iv,
      secretTag: CIPHER.tag,
    });
    await resolveIntegrationSecret('google_places');
    await resolveIntegrationSecret('google_places');
    expect(mockState.credentialFindUnique).toHaveBeenCalledTimes(1);
  });

  it('invalidateIntegrationCredentialCache forces the next call to hit the DB again', async () => {
    mockState.credentialFindUnique.mockResolvedValue({
      secretCiphertext: CIPHER.ciphertext,
      secretIv: CIPHER.iv,
      secretTag: CIPHER.tag,
    });
    await resolveIntegrationSecret('google_places');
    invalidateIntegrationCredentialCache('google_places');
    await resolveIntegrationSecret('google_places');
    expect(mockState.credentialFindUnique).toHaveBeenCalledTimes(2);
  });

  it('saving a new credential invalidates the cache for that toolKey', async () => {
    mockState.credentialFindUnique.mockResolvedValue({
      secretCiphertext: CIPHER.ciphertext,
      secretIv: CIPHER.iv,
      secretTag: CIPHER.tag,
    });
    await resolveIntegrationSecret('google_places');
    await saveIntegrationCredential('google_places', 'Google Places', 'AIzaNewOne', ACTOR);
    await resolveIntegrationSecret('google_places');
    // 1 (initial) + 1 (save's own existence check) + 1 (post-save re-resolve)
    expect(mockState.credentialFindUnique).toHaveBeenCalledTimes(3);
  });

  it('different toolKeys are cached independently', async () => {
    mockState.credentialFindUnique.mockResolvedValue({
      secretCiphertext: CIPHER.ciphertext,
      secretIv: CIPHER.iv,
      secretTag: CIPHER.tag,
    });
    await resolveIntegrationSecret('google_places');
    await resolveIntegrationSecret('some_other_tool');
    expect(mockState.credentialFindUnique).toHaveBeenCalledTimes(2);
  });
});

describe('resolveIntegrationClientId', () => {
  it('returns null when the database is not configured', async () => {
    mockState.isDatabaseConfigured = false;
    expect(await resolveIntegrationClientId('google_business')).toBeNull();
  });

  it('returns null when no credential row exists', async () => {
    expect(await resolveIntegrationClientId('google_business')).toBeNull();
  });

  it('returns the cleartext clientId when a row exists — never decrypts', async () => {
    mockState.credentialFindUnique.mockResolvedValue({
      secretCiphertext: CIPHER.ciphertext,
      secretIv: CIPHER.iv,
      secretTag: CIPHER.tag,
      clientId: '123-abc.apps.googleusercontent.com',
    });
    expect(await resolveIntegrationClientId('google_business')).toBe('123-abc.apps.googleusercontent.com');
    expect(mockState.decryptBuffer).toHaveBeenCalledTimes(1); // for the secret half of the same cached row
  });

  it('returns null for a single-secret tool with no clientId column value', async () => {
    mockState.credentialFindUnique.mockResolvedValue({
      secretCiphertext: CIPHER.ciphertext,
      secretIv: CIPHER.iv,
      secretTag: CIPHER.tag,
      clientId: null,
    });
    expect(await resolveIntegrationClientId('google_places')).toBeNull();
  });

  it('shares the same cache entry as resolveIntegrationSecret — one row fetch covers both', async () => {
    mockState.credentialFindUnique.mockResolvedValue({
      secretCiphertext: CIPHER.ciphertext,
      secretIv: CIPHER.iv,
      secretTag: CIPHER.tag,
      clientId: '123-abc.apps.googleusercontent.com',
    });
    await resolveIntegrationSecret('google_business');
    await resolveIntegrationClientId('google_business');
    expect(mockState.credentialFindUnique).toHaveBeenCalledTimes(1);
  });
});
