// =============================================================================
// WP: conexión de canales — unit tests for src/lib/meta-business.ts.
//
// Mocked-fetch coverage for the Graph API shapes (mirrors
// google-business.test.ts's structure) plus a real encrypt/decrypt
// round-trip via channel-crypto.ts. Explicitly NOT a live-API test —
// there is no real Meta App configured anywhere this session had access
// to; these assert the request/response contract this code was written
// against, not that Meta's actual API still matches it.
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  fetch: vi.fn(),
  logError: vi.fn(),
}));

vi.stubGlobal('fetch', mockState.fetch);

vi.mock('@/lib/observability', () => ({
  logError: (...args: unknown[]) => mockState.logError(...args),
}));

import {
  isMetaSignupConfigured,
  isCoexistenceSignupConfigured,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchPagesWithInstagram,
  revokeMetaAccess,
  encryptMetaToken,
  decryptMetaToken,
} from '@/lib/meta-business';

const ENV_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_CONFIG_ID',
  'META_COEXISTENCE_CONFIG_ID',
  'META_GRAPH_API_VERSION',
  'CHANNEL_CREDENTIAL_ENCRYPTION_KEY',
] as const;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  mockState.fetch.mockReset();
  mockState.logError.mockReset();
  process.env.META_APP_ID = 'app_123';
  process.env.META_APP_SECRET = 'app_secret_123';
  process.env.META_CONFIG_ID = 'config_123';
  process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('isMetaSignupConfigured', () => {
  it('true when all three env vars are set', () => {
    expect(isMetaSignupConfigured()).toBe(true);
  });

  it('false when META_CONFIG_ID is missing', () => {
    delete process.env.META_CONFIG_ID;
    expect(isMetaSignupConfigured()).toBe(false);
  });
});

describe('isCoexistenceSignupConfigured', () => {
  it('false by default — a SEPARATE Configuration from META_CONFIG_ID, not implied by it', () => {
    expect(isCoexistenceSignupConfigured()).toBe(false);
  });

  it('true once META_COEXISTENCE_CONFIG_ID is set alongside the app credentials', () => {
    process.env.META_COEXISTENCE_CONFIG_ID = 'coexistence_config_123';
    expect(isCoexistenceSignupConfigured()).toBe(true);
    // The standard flow's gate is unaffected either way.
    expect(isMetaSignupConfigured()).toBe(true);
  });

  it('false when the app id/secret are missing even if the coexistence config id is set', () => {
    process.env.META_COEXISTENCE_CONFIG_ID = 'coexistence_config_123';
    delete process.env.META_APP_ID;
    expect(isCoexistenceSignupConfigured()).toBe(false);
  });
});

describe('exchangeCodeForToken', () => {
  it('returns the access token on success', async () => {
    mockState.fetch.mockResolvedValue(jsonResponse({ access_token: 'short_lived_token', expires_in: 5400 }));
    const result = await exchangeCodeForToken('auth_code_1');
    expect(result).toEqual({ accessToken: 'short_lived_token', expiresIn: 5400 });
    expect(mockState.fetch).toHaveBeenCalledWith(expect.stringContaining('code=auth_code_1'));
  });

  it('returns null on a non-ok response', async () => {
    mockState.fetch.mockResolvedValue(jsonResponse({ error: 'invalid' }, false, 400));
    const result = await exchangeCodeForToken('bad_code');
    expect(result).toBeNull();
  });

  it('returns null and logs on a network error, never throws', async () => {
    mockState.fetch.mockRejectedValue(new Error('ECONNRESET'));
    const result = await exchangeCodeForToken('code');
    expect(result).toBeNull();
    expect(mockState.logError).toHaveBeenCalled();
  });

  it('throws when META_APP_ID/META_APP_SECRET are unset', async () => {
    delete process.env.META_APP_ID;
    await expect(exchangeCodeForToken('code')).rejects.toThrow('META_APP_ID/META_APP_SECRET not configured');
  });
});

describe('exchangeForLongLivedToken', () => {
  it('returns the long-lived token on success', async () => {
    mockState.fetch.mockResolvedValue(jsonResponse({ access_token: 'long_lived_token', expires_in: 5183944 }));
    const result = await exchangeForLongLivedToken('short_lived_token');
    expect(result).toEqual({ accessToken: 'long_lived_token', expiresIn: 5183944 });
    expect(mockState.fetch).toHaveBeenCalledWith(expect.stringContaining('grant_type=fb_exchange_token'));
  });

  it('returns null on failure', async () => {
    mockState.fetch.mockResolvedValue(jsonResponse({}, false, 500));
    const result = await exchangeForLongLivedToken('x');
    expect(result).toBeNull();
  });
});

describe('fetchPagesWithInstagram', () => {
  it('maps pages and their linked Instagram account when present', async () => {
    mockState.fetch.mockResolvedValue(
      jsonResponse({
        data: [
          { id: 'page_1', name: 'Peluquería Aurora', instagram_business_account: { id: 'ig_1' } },
          { id: 'page_2', name: 'Aurora Spa' },
        ],
      }),
    );
    const result = await fetchPagesWithInstagram('token_1');
    expect(result).toEqual([
      { pageId: 'page_1', pageName: 'Peluquería Aurora', instagramAccountId: 'ig_1' },
      { pageId: 'page_2', pageName: 'Aurora Spa', instagramAccountId: null },
    ]);
  });

  it('returns an empty array on a non-ok response', async () => {
    mockState.fetch.mockResolvedValue(jsonResponse({}, false, 401));
    await expect(fetchPagesWithInstagram('token')).resolves.toEqual([]);
  });

  it('returns an empty array and logs on a network error, never throws', async () => {
    mockState.fetch.mockRejectedValue(new Error('network down'));
    await expect(fetchPagesWithInstagram('token')).resolves.toEqual([]);
    expect(mockState.logError).toHaveBeenCalled();
  });
});

describe('revokeMetaAccess', () => {
  it('returns true on a successful DELETE', async () => {
    mockState.fetch.mockResolvedValue(jsonResponse({ success: true }));
    await expect(revokeMetaAccess('token')).resolves.toBe(true);
    expect(mockState.fetch).toHaveBeenCalledWith(expect.stringContaining('/me/permissions'), { method: 'DELETE' });
  });

  it('returns false (not throws) on failure', async () => {
    mockState.fetch.mockRejectedValue(new Error('boom'));
    await expect(revokeMetaAccess('token')).resolves.toBe(false);
  });
});

describe('encryptMetaToken / decryptMetaToken — round trip (real AES-256-GCM)', () => {
  it('decrypts back to the original plaintext', () => {
    const plaintext = 'EAAG-example-long-lived-token';
    const encrypted = encryptMetaToken(plaintext);
    expect(decryptMetaToken(encrypted)).toBe(plaintext);
  });
});
