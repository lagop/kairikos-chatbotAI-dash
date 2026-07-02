/**
 * KAIA-2869 — Seed test users for the CEO's hands-on credentials test.
 * KAIA-2900 — Make the password env-var driven so the Playwright fixture
 *            can log in via `portal-credentials` (no magic-link detour).
 *
 * Sets known plaintext passwords for:
 *   - onboarding-test1@kairikos.dev  (client, role='client')
 *   - onboarding-test2@kairikos.dev  (client, role='client')
 *   - staff-test@kairikos.dev        (client, role='client')
 *   - ops-staging@kairikos.com       (operator, role='operator')
 *
 * The CEO will log in at https://project-fxidg.vercel.app/portal/login
 * (portal-credentials) and /admin/login (admin-credentials). The Playwright
 * fixture in tests/fixtures/portal.ts reads the same env var to drive the
 * credentials login against the seeded users.
 *
 * Hashing uses argon2id via the same @node-rs/argon2 lib the production
 * auth.ts uses, so verifyPassword in the credentials provider will accept
 * these passwords.
 *
 * Plaintext password resolution (first match wins):
 *   1. STAGING_TEST_USER_PASSWORD              (canonical name — QA's
 *      load-secrets.sh sources this from .env; documented in
 *      portal/.env.example + STAGING.md. KAIA-2900.)
 *   2. TEST_PASSWORD_<EMAIL_SANITISED>         (per-user override)
 *   3. TEST_PASSWORD                           (legacy, all users)
 *   4. defaultPassword below                    (hard-coded last-resort)
 *
 * Idempotent: re-running this script updates the passwordHash in place.
 */

import { createInterface } from 'node:readline';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/operator-crypto';

const prisma = new PrismaClient();

// KAIA-2869 — Test users for CEO hands-on credentials test.
//
// Schema note: production auth.ts has two Credentials providers:
//   - portal-credentials: requires User.role='client' AND a linked ChatbotClientUser
//   - admin-credentials:  requires a row in the Operator table
//
// The CEO asked for "2 test users + 1 staff/admin". The existing seed users
// (onboarding-test1/2, staff-test) are already in the User table with
// role='client' and linked ChatbotClientUser rows — they authenticate via
// the portal. The "staff/admin" credential is provided by ops-staging,
// which lives in the Operator table and authenticates via /admin/login.
const TEST_USERS: Array<{
  email: string;
  defaultPassword: string;
  role: 'client' | 'operator';
  description: string;
}> = [
  {
    email: 'onboarding-test1@kairikos.dev',
    defaultPassword: 'KairikosTest2026!',
    role: 'client',
    description: 'Acme Clay Ovens — fully onboarded client (Pro tier)',
  },
  {
    email: 'onboarding-test2@kairikos.dev',
    defaultPassword: 'KairikosTest2026!',
    role: 'client',
    description: 'Brisa Beach Houses — mid-onboarding client (Starter tier)',
  },
  {
    email: 'staff-test@kairikos.dev',
    defaultPassword: 'KairikosTest2026!',
    role: 'client',
    description: 'Staff-role client (3rd seeded client user; logs in via /portal/login)',
  },
  {
    email: 'ops-staging@kairikos.com',
    defaultPassword: 'KairikosTest2026!',
    role: 'operator',
    description: 'Operator/admin (logs in via /admin/login with admin-credentials provider)',
  },
];

function readPasswordEnv(email: string, fallback: string): string {
  const envKey = `TEST_PASSWORD_${email.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  // KAIA-2900 — STAGING_TEST_USER_PASSWORD is the canonical name the QA
  // fixture (tests/fixtures/portal.ts) and load-secrets.sh agree on.
  // Per-user and legacy TEST_PASSWORD overrides still take priority so
  // operators who already set those keep working without a rename.
  return (
    process.env[envKey] ??
    process.env.TEST_PASSWORD ??
    process.env.STAGING_TEST_USER_PASSWORD ??
    fallback
  );
}

async function ensureClientUser(email: string, role: 'client' | 'operator'): Promise<void> {
  // For 'client' users: ensure a User row + ChatbotClientUser link.
  // For 'operator' users: ensure a User row (some operator login flows check
  // User.role) AND an Operator row.
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await prisma.user.create({
      data: {
        email,
        role,
        passwordSetAt: new Date(),
      },
    });
  } else if (user.role !== role) {
    await prisma.user.update({
      where: { email },
      data: { role },
    });
  }

  if (role === 'operator') {
    const op = await prisma.operator.findUnique({ where: { email } });
    if (!op) {
      await prisma.operator.create({
        data: {
          email,
          isActive: true,
        },
      });
    } else if (!op.isActive) {
      await prisma.operator.update({
        where: { email },
        data: { isActive: true },
      });
    }
  }
}

async function setPassword(email: string, password: string): Promise<string> {
  const hash = await hashPassword(password);
  await prisma.user.update({
    where: { email },
    data: {
      passwordHash: hash,
      passwordSetAt: new Date(),
    },
  });
  return hash;
}

async function setOperatorPassword(email: string, password: string): Promise<string> {
  const hash = await hashPassword(password);
  await prisma.operator.update({
    where: { email },
    data: {
      passwordHash: hash,
      updatedAt: new Date(),
    },
  });
  return hash;
}

async function main(): Promise<void> {
  console.log('[seed-credentials] starting');
  console.log(`[seed-credentials] DATABASE_URL host: ${process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] ?? '<unset>'}`);

  const results: Array<{ email: string; ok: boolean; role: string; message: string }> = [];

  for (const u of TEST_USERS) {
    const password = readPasswordEnv(u.email, u.defaultPassword);
    try {
      await ensureClientUser(u.email, u.role);

      if (u.role === 'operator') {
        await setOperatorPassword(u.email, password);
        await setPassword(u.email, password);
      } else {
        await setPassword(u.email, password);
      }

      results.push({ email: u.email, ok: true, role: u.role, message: 'password updated' });
      console.log(`[seed-credentials] OK ${u.email} (${u.role})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ email: u.email, ok: false, role: u.role, message: msg });
      console.error(`[seed-credentials] FAIL ${u.email}: ${msg}`);
    }
  }

  console.log('\n[seed-credentials] summary:');
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.email} [${r.role}] — ${r.message}`);
  }

  const allOk = results.every((r) => r.ok);
  if (!allOk) {
    console.error('[seed-credentials] some seeds failed');
    process.exit(1);
  }

  console.log('\n[seed-credentials] plaintext credentials (CEO test):');
  for (const u of TEST_USERS) {
    const password = readPasswordEnv(u.email, u.defaultPassword);
    console.log(`  Email: ${u.email}`);
    console.log(`  Password: ${password}`);
    console.log(`  Role: ${u.role}`);
    console.log('');
  }

  console.log('[seed-credentials] login URLs:');
  console.log('  Client portal: https://project-fxidg.vercel.app/portal/login');
  console.log('  Admin portal:  https://project-fxidg.vercel.app/admin/login');
}

main()
  .catch((e) => {
    console.error('[seed-credentials] crashed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());