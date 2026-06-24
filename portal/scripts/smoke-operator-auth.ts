// =============================================================================
// KAIA-1107 — Smoke test for the operator auth lib layer.
//
// Exercises operator-crypto.ts (password hashing, TOTP generation/verification,
// recovery codes, encryption-at-rest, in-memory rate limiter) without
// requiring a live database or HTTP server. The DB-bound helpers
// (operator-session.ts) are imported but not invoked against a real DB.
//
// Run:  npx tsx scripts/smoke-operator-auth.ts
// Exit: 0 on success, 1 on any assertion failure.
// =============================================================================

import {
  hashPassword,
  verifyPassword,
  generateTotpSecret,
  verifyTotpCode,
  getTotpUri,
  encryptTotpSecret,
  decryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
  InMemoryRateLimiter,
} from '../src/lib/operator-crypto';

let failures = 0;
function assert(label: string, cond: boolean): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    failures += 1;
  }
}

async function main(): Promise<void> {
  // OPERATOR_TOTP_ENCRYPTION_KEY is required by the encrypt helpers.
  process.env.OPERATOR_TOTP_ENCRYPTION_KEY = process.env.OPERATOR_TOTP_ENCRYPTION_KEY
    ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  console.log('\n[1] Password hashing (argon2id)');
  const password = 'kairikos-dev-operator-2026';
  const hash = await hashPassword(password);
  assert('hash is non-empty', typeof hash === 'string' && hash.length > 30);
  assert('hash starts with $argon2', hash.startsWith('$argon2'));
  assert('verifyPassword accepts correct password', await verifyPassword(hash, password) === true);
  assert('verifyPassword rejects wrong password', await verifyPassword(hash, 'wrong') === false);

  console.log('\n[2] TOTP secret generation + verification (±1 step window)');
  const secret = generateTotpSecret();
  assert('secret is base32 string', /^[A-Z2-7]+$/.test(secret));
  // otplib authenticator ships its own generate method on the instance, not a free function,
  // so we mint a token by reproducing the algorithm via the package entry point.
  const { authenticator } = await import('@otplib/preset-default');
  const token = authenticator.generate(secret);
  assert('verifyTotpCode accepts current token', verifyTotpCode(token, secret) === true);
  assert('verifyTotpCode rejects bad token', verifyTotpCode('000000', secret) === false);

  console.log('\n[3] TOTP URI');
  const uri = getTotpUri(secret, 'ceo@kairikos.com');
  assert('URI has otpauth scheme', uri.startsWith('otpauth://totp/'));
  assert('URI contains issuer', uri.includes('issuer=Kairikos'));
  assert('URI contains account label', uri.includes('ceo%40kairikos.com'));

  console.log('\n[4] TOTP secret encryption at rest (AES-256-GCM)');
  const encrypted = encryptTotpSecret(secret);
  assert('encrypted has iv:tag:data shape', encrypted.split(':').length === 3);
  const decrypted = decryptTotpSecret(encrypted);
  assert('decrypt round-trips to plaintext', decrypted === secret);
  assert('ciphertext differs from plaintext', encrypted !== secret);
  // Tamper detection: flip a byte in the tag and expect decryption to throw.
  const tampered = encrypted.split(':');
  const tagBytes = Buffer.from(tampered[1], 'hex');
  tagBytes[0] = tagBytes[0] ^ 0xff;
  tampered[1] = tagBytes.toString('hex');
  let threwOnTamper = false;
  try {
    decryptTotpSecret(tampered.join(':'));
  } catch {
    threwOnTamper = true;
  }
  assert('GCM tag tampering is rejected', threwOnTamper);

  console.log('\n[5] Recovery codes (8 one-time codes, argon2id hashed)');
  const codes = generateRecoveryCodes(8);
  assert('generated 8 codes', codes.length === 8);
  assert('codes are 12 hex chars each', codes.every((c) => /^[0-9a-f]{12}$/.test(c)));
  assert('codes are unique', new Set(codes).size === 8);
  const codeHashes = await Promise.all(codes.map(hashRecoveryCode));
  assert('all hashes are argon2id', codeHashes.every((h) => h.startsWith('$argon2')));
  // Each plaintext should verify against exactly one of its own hash.
  for (let i = 0; i < codes.length; i += 1) {
    const ok = await verifyRecoveryCode(codeHashes[i], codes[i]);
    assert(`code[${i}] verifies against own hash`, ok === true);
  }
  assert('wrong code rejected', (await verifyRecoveryCode(codeHashes[0], 'deadbeef0000')) === false);

  console.log('\n[6] In-memory rate limiter (5 attempts per email / 15 min)');
  const limiter = new InMemoryRateLimiter(15 * 60 * 1000);
  const emailKey = 'email:ceo@kairikos.com';
  const firstFive = [1, 2, 3, 4, 5].map(() => limiter.check(emailKey, 5));
  assert('first 5 attempts all allowed', firstFive.every((x) => x === true));
  assert('6th attempt blocked (429)', limiter.check(emailKey, 5) === false);
  // Different key has its own bucket.
  assert('different email has its own bucket', limiter.check('email:other@example.com', 5) === true);

  console.log('\n[7] Different IP bucket (20/IP/15min)');
  const ipLimiter = new InMemoryRateLimiter(15 * 60 * 1000);
  const ipKey = 'ip:203.0.113.5';
  const ipAllowed = Array.from({ length: 20 }, () => ipLimiter.check(ipKey, 20)).every((x) => x === true);
  assert('first 20 IP attempts all allowed', ipAllowed);
  assert('21st IP attempt blocked', ipLimiter.check(ipKey, 20) === false);

  console.log(`\n=== ${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`} ===`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
