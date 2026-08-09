// =============================================================================
// KAIA-12714 — regression smoke for the operator forgot-password + reset
// routes.
//
// Asserts:
//   1. The new /api/operator/forgot-password route exists, uses Prisma
//      `Operator`, mints a sha256-hashed token, and silently returns
//      `{ok:true}` for unknown emails (no enumeration).
//   2. The new /api/operator/reset-password route exists, consumes the
//      token, writes the Operator.passwordHash, and burns the token.
//   3. The /admin/forgot-password and /admin/reset-password pages now
//      POST to /api/operator/forgot-password and /api/operator/reset-password
//      respectively (NOT to the customer route).
//   4. The customer /api/portal/forgot-password and
//      /api/portal/reset-password routes are STILL wired to the customer
//      ChatbotClientUser → User model only (no Operator leakage).
//
// The smoke reads the source files directly (no live HTTP surface). It
// fails fast if anyone quietly introduces an operator-leakage regression
// in the customer route or wires the admin UI back to the customer API.
//
// Run:   npx tsx scripts/smoke-kaia-12714-operator-forgot-password.ts
// Exit:  0 on success, 1 on any failure.
// =============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..');

function read(path: string): string {
  return readFileSync(join(REPO, path), 'utf8');
}

type Check = { title: string; pass: boolean; detail?: string };

function check(title: string, ok: boolean, detail?: string): Check {
  return { title, pass: ok, detail };
}

function main() {
  const operatorForgot = read('src/app/api/operator/forgot-password/route.ts');
  const operatorReset = read('src/app/api/operator/reset-password/route.ts');
  const customerForgot = read('src/app/api/portal/forgot-password/route.ts');
  const customerReset = read('src/app/api/portal/reset-password/route.ts');
  const adminForgotClient = read('src/app/admin/forgot-password/_client.tsx');
  const adminResetClient = read('src/app/admin/reset-password/_client.tsx');
  const operatorCrypto = read('src/lib/operator-crypto.ts');

  const results: Check[] = [];

  // ---- New operator forgot-password route --------------------------------
  results.push(
    check(
      '/api/operator/forgot-password exists and uses prisma.operator',
      /prisma\.operator\.findUnique\s*\(\s*\{[\s\S]*?where:\s*\{\s*email/.test(operatorForgot)
    )
  );
  results.push(
    check(
      '/api/operator/forgot-password mints sha256-hashed token + writes passwordResetToken',
      /passwordResetToken\.create\s*\(\s*\{[\s\S]*?tokenHash/.test(operatorForgot) &&
        /createHash\(['"]sha256['"]\)/.test(operatorForgot)
    )
  );
  results.push(
    check(
      '/api/operator/forgot-password silently returns ok:true for unknown email (no enumeration)',
      /!\s*operator\s*\|\|\s*!\s*operator\.isActive[\s\S]{0,400}NextResponse\.json\(\s*\{\s*ok:\s*true\s*\}/.test(
        operatorForgot
      )
    )
  );
  results.push(
    check(
      '/api/operator/forgot-password burns token on email_send_failed (fail-closed)',
      /passwordResetToken\.updateMany[\s\S]{0,400}usedAt:\s*new Date\(\)/.test(operatorForgot) &&
        /email_send_failed/.test(operatorForgot)
    )
  );
  results.push(
    check(
      '/api/operator/forgot-password applies IP + email rate limiting',
      /InMemoryRateLimiter/.test(operatorForgot)
    )
  );

  // ---- New operator reset-password route ---------------------------------
  results.push(
    check(
      '/api/operator/reset-password exists and looks up by email + sha256-hashed token',
      /prisma\.operator\.findUnique\s*\(\s*\{[\s\S]*?where:\s*\{\s*email/.test(operatorReset) &&
        /prisma\.passwordResetToken\.findFirst/.test(operatorReset) &&
        /createHash\(['"]sha256['"]\)/.test(operatorReset)
    )
  );
  results.push(
    check(
      '/api/operator/reset-password writes Operator.passwordHash via argon2id (operator-crypto.hashPassword)',
      /import\s*\{\s*hashPassword\s*\}\s*from\s*['"]@\/lib\/operator-crypto['"]/.test(operatorReset) &&
        /const\s+passwordHash\s*=\s*await\s+hashPassword\(password\)/.test(operatorReset) &&
        /data:\s*\{\s*passwordHash\s*\}/.test(operatorReset)
    )
  );
  results.push(
    check(
      '/api/operator/reset-password burns token + revokes existing sessions in same transaction',
      /prisma\.\$transaction\s*\(\s*\[/.test(operatorReset) &&
        /operatorSession\.updateMany/.test(operatorReset) &&
        /revokedAt:\s*new Date\(\)/.test(operatorReset)
    )
  );
  results.push(
    check(
      '/api/operator/reset-password never logs the plaintext password or token',
      !/console\.[a-z]+\([^)]*?(?:password|token|tokenHash)/.test(operatorReset)
    )
  );

  // ---- Operator crypto helper is unchanged --------------------------------
  results.push(
    check(
      'src/lib/operator-crypto.ts: hashPassword uses argon2id via @node-rs/argon2',
      /argon2Hash\s*\(/.test(operatorCrypto) &&
        /argon2id/i.test(operatorCrypto)
    )
  );

  // ---- Customer routes are NOT touched (no Operator leakage) -------------
  results.push(
    check(
      'customer /api/portal/forgot-password does NOT mention Operator model',
      !/Operator\s*\./.test(customerForgot) && !/prisma\.operator\.findUnique/.test(customerForgot)
    )
  );
  results.push(
    check(
      'customer /api/portal/forgot-password still resolves via ChatbotClientUser → User',
      /prisma\.chatbotClientUser\.findUnique/.test(customerForgot) &&
        /prisma\.user\.findUnique/.test(customerForgot)
    )
  );
  results.push(
    check(
      'customer /api/portal/reset-password does NOT mention Operator model',
      !/Operator\s*\./.test(customerReset) && !/prisma\.operator\.findUnique/.test(customerReset)
    )
  );
  results.push(
    check(
      'customer /api/portal/reset-password still resolves via ChatbotClientUser → User',
      /prisma\.chatbotClientUser\.findUnique/.test(customerReset) &&
        /prisma\.user\.findUnique/.test(customerReset)
    )
  );

  // ---- Admin UI is wired to the operator API ------------------------------
  results.push(
    check(
      '/admin/forgot-password POSTs to /api/operator/forgot-password',
      /fetch\(\s*['"]\/api\/operator\/forgot-password['"]/.test(adminForgotClient)
    )
  );
  results.push(
    check(
      '/admin/forgot-password does NOT POST to /api/portal/forgot-password',
      !/fetch\(\s*['"]\/api\/portal\/forgot-password['"]/.test(adminForgotClient)
    )
  );
  results.push(
    check(
      '/admin/reset-password POSTs to /api/operator/reset-password',
      /fetch\(\s*['"]\/api\/operator\/reset-password['"]/.test(adminResetClient)
    )
  );
  results.push(
    check(
      '/admin/reset-password does NOT POST to /api/portal/reset-password',
      !/fetch\(\s*['"]\/api\/portal\/reset-password['"]/.test(adminResetClient)
    )
  );

  // ---- Report -------------------------------------------------------------
  let failures = 0;
  for (const r of results) {
    const marker = r.pass ? 'OK  ' : 'FAIL';
    console.log(`[${marker}] ${r.title}${r.detail ? ` — ${r.detail}` : ''}`);
    if (!r.pass) failures += 1;
  }
  if (failures > 0) {
    console.error(`[smoke] FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('[smoke] OK — all assertions passed');
}

main();