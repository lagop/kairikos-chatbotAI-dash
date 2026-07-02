import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';
import * as crypto from 'node:crypto';
import { authenticator } from '@otplib/preset-default';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function getEncryptionKey(): Buffer {
  const raw = process.env.OPERATOR_TOTP_ENCRYPTION_KEY;
  if (!raw) throw new Error('OPERATOR_TOTP_ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'hex');
  if (key.length !== KEY_LENGTH) {
    throw new Error(`OPERATOR_TOTP_ENCRYPTION_KEY must be ${KEY_LENGTH} hex bytes (got ${key.length})`);
  }
  return key;
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

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, { algorithm: Algorithm.Argon2id });
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
  return argon2Hash(code, { algorithm: Algorithm.Argon2id });
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

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
