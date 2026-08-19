// =============================================================================
// WP: conexión de canales — unit tests for src/lib/channel-crypto.ts.
//
// Real AES-256-GCM round trip (not mocked) — mirrors
// tests/unit/google-business.test.ts's encryptRefreshToken/
// decryptRefreshToken coverage for the same class of guarantee: the
// credential never gets written in plaintext.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptChannelCredential, decryptChannelCredential } from '@/lib/channel-crypto';

beforeEach(() => {
  process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);
});

afterEach(() => {
  delete process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY;
});

describe('encryptChannelCredential / decryptChannelCredential — round trip (real AES-256-GCM)', () => {
  it('decrypts back to the original plaintext', () => {
    const plaintext = '123456789:AAExampleTelegramBotToken';
    const encrypted = encryptChannelCredential(plaintext);
    expect(encrypted.ciphertext).not.toEqual(Buffer.from(plaintext, 'utf8'));
    expect(decryptChannelCredential(encrypted)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const a = encryptChannelCredential('same-plaintext');
    const b = encryptChannelCredential('same-plaintext');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(decryptChannelCredential(a)).toBe('same-plaintext');
    expect(decryptChannelCredential(b)).toBe('same-plaintext');
  });

  it('throws when CHANNEL_CREDENTIAL_ENCRYPTION_KEY is unset', () => {
    delete process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptChannelCredential('x')).toThrow('CHANNEL_CREDENTIAL_ENCRYPTION_KEY is not set');
  });

  it('throws when CHANNEL_CREDENTIAL_ENCRYPTION_KEY is the wrong length', () => {
    process.env.CHANNEL_CREDENTIAL_ENCRYPTION_KEY = 'too-short';
    expect(() => encryptChannelCredential('x')).toThrow(/must be 32 hex bytes/);
  });

  it('fails to decrypt with a tampered tag (authentication)', () => {
    const encrypted = encryptChannelCredential('secret-token');
    const tampered = { ...encrypted, tag: Buffer.alloc(encrypted.tag.length, 0) };
    expect(() => decryptChannelCredential(tampered)).toThrow();
  });
});
