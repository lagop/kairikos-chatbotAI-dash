// =============================================================================
// WP-21 — unit tests for src/lib/google-business.ts.
//
// Covers: OAuth URL construction, code→token exchange, location
// discovery, revocation, the encrypt/decrypt refresh-token round-trip
// (real AES-256-GCM, not mocked — this is the AC "el token de refresco
// nunca se escribe en claro"), and getValidAccessToken's invalid_grant →
// needs_reconnect degraded-state transition.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  fetch: vi.fn(),
  connectionUpdate: vi.fn(),
  logError: vi.fn(),
}));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    googleBusinessConnection: {
      update: (...args: unknown[]) => mockState.connectionUpdate(...args),
    },
  },
}));

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import {
  isGoogleBusinessOAuthConfigured,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchAccessibleLocations,
  revokeGoogleToken,
  encryptRefreshToken,
  decryptRefreshToken,
  getValidAccessToken,
  publishReviewReply,
} from '@/lib/google-business';

const ENV_KEYS = [
  'GOOGLE_BUSINESS_OAUTH_CLIENT_ID',
  'GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET',
  'GOOGLE_BUSINESS_OAUTH_REDIRECT_URI',
  'GOOGLE_TOKEN_ENCRYPTION_KEY',
  'NEXT_PUBLIC_PORTAL_URL',
] as const;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.connectionUpdate.mockReset().mockResolvedValue({});
  mockState.logError.mockReset();
  process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID = 'client_id_1';
  process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET = 'client_secret_1';
  process.env.GOOGLE_BUSINESS_OAUTH_REDIRECT_URI = 'https://portal.kairikos.test/api/portal/google-business/oauth/callback';
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.NEXT_PUBLIC_PORTAL_URL = 'https://portal.kairikos.test';
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('isGoogleBusinessOAuthConfigured', () => {
  it('true when all three required env vars are set', () => {
    expect(isGoogleBusinessOAuthConfigured()).toBe(true);
  });

  it('false when the encryption key is missing', () => {
    delete process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
    expect(isGoogleBusinessOAuthConfigured()).toBe(false);
  });
});

describe('buildAuthorizationUrl', () => {
  it('includes the business.manage scope, offline+consent, and the caller-supplied state', () => {
    const url = new URL(buildAuthorizationUrl('state-abc-123'));
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/business.manage');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-abc-123');
    expect(url.searchParams.get('client_id')).toBe('client_id_1');
    expect(url.searchParams.get('redirect_uri')).toBe(process.env.GOOGLE_BUSINESS_OAUTH_REDIRECT_URI);
  });
});

describe('exchangeCodeForTokens', () => {
  it('returns the parsed tokens on success', async () => {
    mockState.fetch.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, scope: 'business.manage' }),
    );
    const result = await exchangeCodeForTokens('code_1');
    expect(result).toEqual({ accessToken: 'at_1', refreshToken: 'rt_1', expiresIn: 3600, scope: 'business.manage' });
  });

  it('returns null when Google responds non-ok', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, false, 400));
    const result = await exchangeCodeForTokens('code_1');
    expect(result).toBeNull();
  });

  it('returns null and logs on network error, never throws', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await exchangeCodeForTokens('code_1');
    expect(result).toBeNull();
    expect(mockState.logError).toHaveBeenCalledWith('google_business.exchange_code', expect.any(Error), expect.anything(), 'warn');
  });
});

describe('fetchAccessibleLocations', () => {
  it('aggregates locations across every account the token can access', async () => {
    mockState.fetch
      .mockResolvedValueOnce(
        jsonResponse({
          accounts: [
            { name: 'accounts/1', accountName: 'Clínica Dental Orly' },
            { name: 'accounts/2', accountName: 'Otro negocio' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ locations: [{ name: 'accounts/1/locations/10', title: 'Sede Centro' }] }))
      .mockResolvedValueOnce(jsonResponse({ locations: [{ name: 'accounts/2/locations/20', title: 'Sede Norte' }] }));

    const result = await fetchAccessibleLocations('at_1');
    expect(result).toEqual([
      { accountId: 'accounts/1', accountName: 'Clínica Dental Orly', locationId: 'accounts/1/locations/10', locationName: 'Sede Centro' },
      { accountId: 'accounts/2', accountName: 'Otro negocio', locationId: 'accounts/2/locations/20', locationName: 'Sede Norte' },
    ]);
  });

  it('returns an empty array when the accounts call fails', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({}, false, 403));
    const result = await fetchAccessibleLocations('at_1');
    expect(result).toEqual([]);
  });
});

describe('revokeGoogleToken', () => {
  it('returns true when Google accepts the revoke call', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({}));
    expect(await revokeGoogleToken('rt_1')).toBe(true);
  });

  it('returns false (not throw) when Google rejects the revoke call', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({}, false, 400));
    expect(await revokeGoogleToken('rt_1')).toBe(false);
  });
});

describe('encryptRefreshToken / decryptRefreshToken — round trip (real AES-256-GCM)', () => {
  it('decrypts back to the exact original plaintext', () => {
    const plaintext = '1//0g_a_real_looking_refresh_token_value';
    const encrypted = encryptRefreshToken(plaintext);
    expect(Buffer.isBuffer(encrypted.ciphertext)).toBe(true);
    expect(encrypted.ciphertext.toString('utf8')).not.toContain(plaintext);
    expect(decryptRefreshToken(encrypted)).toBe(plaintext);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptRefreshToken('same-plaintext');
    const b = encryptRefreshToken('same-plaintext');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });
});

describe('getValidAccessToken', () => {
  function storedConnection(plaintext: string, overrides: { id?: string } = {}) {
    const enc = encryptRefreshToken(plaintext);
    return {
      id: overrides.id ?? 'conn_1',
      refreshTokenCiphertext: enc.ciphertext,
      refreshTokenIv: enc.iv,
      refreshTokenTag: enc.tag,
    };
  }

  it('returns a fresh access token on success', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ access_token: 'at_fresh' }));
    const result = await getValidAccessToken(storedConnection('rt_valid'));
    expect(result).toBe('at_fresh');
    expect(mockState.connectionUpdate).not.toHaveBeenCalled();
  });

  it('flips the connection to needs_reconnect on invalid_grant and returns null', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, false, 400));
    const result = await getValidAccessToken(storedConnection('rt_revoked', { id: 'conn_42' }));
    expect(result).toBeNull();
    expect(mockState.connectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conn_42' },
        data: expect.objectContaining({ status: 'needs_reconnect' }),
      }),
    );
  });

  it('does NOT touch the connection row for a non-invalid_grant failure (transient error)', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({ error: 'server_error' }, false, 500));
    const result = await getValidAccessToken(storedConnection('rt_valid'));
    expect(result).toBeNull();
    expect(mockState.connectionUpdate).not.toHaveBeenCalled();
  });

  it('returns null without throwing when the stored ciphertext cannot be decrypted', async () => {
    const result = await getValidAccessToken({
      id: 'conn_bad',
      refreshTokenCiphertext: Buffer.from('garbage'),
      refreshTokenIv: Buffer.alloc(16, 1),
      refreshTokenTag: Buffer.alloc(16, 2),
    });
    expect(result).toBeNull();
    expect(mockState.fetch).not.toHaveBeenCalled();
  });

  it('returns null without throwing when GOOGLE_BUSINESS_OAUTH_CLIENT_ID/SECRET are unset — a real reachable state, not theoretical: a connection row can already exist from when OAuth WAS configured', async () => {
    delete process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET;
    const result = await getValidAccessToken(storedConnection('rt_valid'));
    expect(result).toBeNull();
    expect(mockState.fetch).not.toHaveBeenCalled();
    expect(mockState.logError).toHaveBeenCalledWith(
      'google_business.refresh_access_token',
      expect.any(Error),
      expect.anything(),
    );
  });
});

describe('publishReviewReply (WP-22c)', () => {
  it('returns ok:true on a successful PUT', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({}));
    const result = await publishReviewReply('at_1', 'accounts/1/locations/2/reviews/3', 'Gracias por tu reseña');
    expect(result).toEqual({ ok: true });
    const [url, init] = mockState.fetch.mock.calls[0];
    expect(url).toBe('https://mybusiness.googleapis.com/v4/accounts/1/locations/2/reviews/3/reply');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ comment: 'Gracias por tu reseña' });
  });

  it('maps a 401/403 to needs_reconnect specifically', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({}, false, 403));
    const result = await publishReviewReply('at_1', 'accounts/1/locations/2/reviews/3', 'x');
    expect(result).toEqual({ ok: false, error: 'needs_reconnect' });
  });

  it('maps any other non-ok status to api_error', async () => {
    mockState.fetch.mockResolvedValueOnce(jsonResponse({}, false, 500));
    const result = await publishReviewReply('at_1', 'accounts/1/locations/2/reviews/3', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('api_error');
  });

  it('maps a network failure to api_error, never throws', async () => {
    mockState.fetch.mockRejectedValueOnce(new Error('network down'));
    const result = await publishReviewReply('at_1', 'accounts/1/locations/2/reviews/3', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('api_error');
  });
});
