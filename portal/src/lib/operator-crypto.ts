import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';
import * as crypto from 'node:crypto';
import { authenticator } from '@otplib/preset-default';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// WP-01 — `Algorithm` is an ambient `const enum` in @node-rs/argon2's type
// declarations. Next.js transpiles each file independently (isolatedModules),
// which cannot inline const-enum member access, so `Algorithm.Argon2id`
// doesn't type-check under that mode. Argon2id = 2 in the upstream
// declaration (node_modules/@node-rs/argon2/index.d.ts); mirror the value
// directly instead of importing the enum as a value.
const ARGON2ID: Algorithm = 2 as Algorithm;

function getEncryptionKey(): Buffer {
  return parseHexKey('OPERATOR_TOTP_ENCRYPTION_KEY', process.env.OPERATOR_TOTP_ENCRYPTION_KEY);
}

export function encryptTotpSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptTotpSecret(encrypted: string): string {
  const key = getEncryptionKey();
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted TOTP secret format');
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const data = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final('utf8');
}

// WP-21 — a generic, buffer-in/buffer-out sibling to
// encryptTotpSecret/decryptTotpSecret above, for callers whose storage
// shape is three separate columns (ciphertext/iv/tag) rather than one
// colon-joined hex string — GoogleBusinessConnection's refresh token
// being the first. Same algorithm and constants as the TOTP functions;
// deliberately parameterized on `key` rather than reading an env var
// itself, so a caller encrypting a different class of secret (e.g. a
// third-party OAuth refresh token) supplies its OWN dedicated key rather
// than reusing OPERATOR_TOTP_ENCRYPTION_KEY — different secret classes
// should never share key material.
export interface EncryptedBuffer {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function encryptBuffer(plaintext: string, key: Buffer): EncryptedBuffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

export function decryptBuffer(parts: EncryptedBuffer, key: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, parts.iv);
  decipher.setAuthTag(parts.tag);
  return decipher.update(parts.ciphertext) + decipher.final('utf8');
}

/** Parse and length-validate a hex-encoded AES-256 key from an env var.
 *  Shared by every caller that stores its encryption key as a 32-byte hex
 *  string (OPERATOR_TOTP_ENCRYPTION_KEY, GOOGLE_TOKEN_ENCRYPTION_KEY, …). */
export function parseHexKey(envVarName: string, raw: string | undefined): Buffer {
  if (!raw) throw new Error(`${envVarName} is not set`);
  const key = Buffer.from(raw, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`${envVarName} must be ${KEY_LENGTH} hex bytes (got ${key.length})`);
  }
  return key;
}

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, { algorithm: ARGON2ID });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, password);
  } catch {
    return false;
  }
}

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function getTotpUri(secret: string, email: string): string {
  return authenticator.keyuri(email, 'Kairikos', secret);
}

export function verifyTotpCode(token: string, secret: string): boolean {
  try {
    return (authenticator as unknown as {
      verify(opts: { token: string; secret: string; window?: number | [number, number] }): boolean;
    }).verify({ token, secret, window: [1, 1] });
  } catch {
    return false;
  }
}

export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(6).toString('hex'));
  }
  return codes;
}

export async function hashRecoveryCode(code: string): Promise<string> {
  return argon2Hash(code, { algorithm: ARGON2ID });
}

export async function verifyRecoveryCode(hash: string, code: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, code);
  } catch {
    return false;
  }
}

interface RateLimitBucket {
  tokens: number[];
}

export class InMemoryRateLimiter {
  private store = new Map<string, RateLimitBucket>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(private readonly windowMs: number = 15 * 60 * 1000) {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.store) {
      bucket.tokens = bucket.tokens.filter((t) => now - t < this.windowMs);
      if (bucket.tokens.length === 0) this.store.delete(key);
    }
  }

  check(key: string, limit: number): boolean {
    const now = Date.now();
    let bucket = this.store.get(key);
    if (!bucket) {
      bucket = { tokens: [] };
      this.store.set(key, bucket);
    }
    bucket.tokens = bucket.tokens.filter((t) => now - t < this.windowMs);
    if (bucket.tokens.length >= limit) return false;
    bucket.tokens.push(now);
    return true;
  }
}

// WP-25 — the canonical constant-time comparison for every shared-secret
// header check in this repo (x-kaia-operator-key, x-qa-probe-token,
// x-qa-seed-token, x-internal-activity-key, PORTAL_API_KEY). Previously
// this returned early on a length mismatch, which leaks the expected
// secret's length through response timing — a real (if minor) side
// channel, and the exact same class of bug the early-return variants in
// internal-auth.ts / activity-key-auth.ts / qa-probe/route.ts /
// qa/seed-test-passwords/route.ts had each independently worked around
// or, in two cases, not worked around at all. One correct implementation
// instead of five near-identical ones of varying quality.
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still run timingSafeEqual against a same-length buffer so the
    // length check itself does not become a fast-path timing signal.
    const padded = Buffer.alloc(bufB.length, 0);
    bufA.copy(padded);
    crypto.timingSafeEqual(padded, bufB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
