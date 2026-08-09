/**
 * KAIA-2900 — Set a known passwordHash on the seeded portal test users.
 *
 * Why this exists
 * ---------------
 * `portal/auth.ts` only exposes two Credentials providers:
 *   - portal-credentials : email + password → prisma.user
 *   - admin-credentials  : email + password → prisma.operator
 * The Supabase magic-link flow (used by KAIA-2898's `authedPortalFixture`)
 * returns a Cloudflare `__cf_bm` cookie and a Supabase fragment token, not a
 * NextAuth `authjs.session-token` cookie. So a magic-link redirect lands the
 * browser back at `/portal/dashboard` unauthenticated.
 *
 * The Playwright fixture in `tests/fixtures/portal.ts` therefore needs a real
 * password on each seeded `User` row to drive `portal-credentials`. This
 * script writes that password using the same `hashPassword` function the
 * request path verifies with, so the hash format is byte-compatible.
 *
 * Plaintext password resolution (first match wins)
 * ------------------------------------------------
 *   1. TEST_PASSWORD_<EMAIL_SAN>      (per-user override, legacy)
 *   2. TEST_PASSWORD                  (legacy, all users)
 *   3. STAGING_TEST_USER_PASSWORD     (canonical — KAIA-2900; the same name
 *                                       `tests/fixtures/portal.ts` and
 *                                       `scripts/load-secrets.sh` agree on)
 *   4. 'KairikosTest2026!'            (hard-coded last resort, never logged)
 *
 * Users seeded (idempotent)
 * -------------------------
 *   - onboarding-test1@kairikos.dev  (client — Acme Clay Ovens, Pro tier)
 *   - onboarding-test2@kairikos.dev  (client — Brisa Beach Houses, Starter)
 *   - staff-test@kairikos.dev        (client — staff-role seed)
 *
 * Idempotent: re-running this script refreshes the passwordHash on the
 * existing rows (and inserts a row if one was missing).
 *
 * Run from the portal repo root:
 *
 *   cd /paperclip/instances/default/.../portal
 *   SUPABASE_URL=https://ikexqreuvoqwvwopftkt.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
 *   STAGING_TEST_USER_PASSWORD='<paste from 1Password>' \
 *     npx tsx scripts/seed-test-passwords.ts
 *
 * Why a Supabase REST script (and not `prisma db execute`)
 * ---------------------------------------------------------
 * Same reason as scripts/seed-staging-operator.ts: the agent runtime cannot
 * reach `db.ikexqreuvoqwvwopftkt.supabase.co:5432` directly
 * (`Network is unreachable` — see KAIA-1435, KAIA-1472). The Supabase REST
 * API on 443 is reachable from anywhere, and the service role key bypasses
 * RLS. We use @supabase/supabase-js + src/lib/operator-crypto.hashPassword
 * (already a portal dependency — no new packages).
 *
 * Exit: 0 on success, 1 on any error. Never prints the password or hash.
 */

import { createClient } from '@supabase/supabase-js';
import { hashPassword } from '../src/lib/operator-crypto';

interface TestUser {
  email: string;
  description: string;
}

const TEST_USERS: TestUser[] = [
  {
    email: 'onboarding-test1@kairikos.dev',
    description: 'Acme Clay Ovens — fully onboarded client (Pro tier)',
  },
  {
    email: 'onboarding-test2@kairikos.dev',
    description: 'Brisa Beach Houses — mid-onboarding client (Starter tier)',
  },
  {
    email: 'staff-test@kairikos.dev',
    description: 'Staff-role client (3rd seeded client user; logs in via /portal/login)',
  },
];

const DEFAULT_PASSWORD = 'KairikosTest2026!';

function readPassword(email: string): string {
  const perUserKey = `TEST_PASSWORD_${email.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return (
    process.env[perUserKey] ??
    process.env.TEST_PASSWORD ??
    process.env.STAGING_TEST_USER_PASSWORD ??
    DEFAULT_PASSWORD
  );
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[seed-test-passwords] FATAL: env var ${name} is not set.`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Compute the hash once with the SAME function the request path uses.
  // operator-crypto.hashPassword → @node-rs/argon2 argon2id, identical
  // parameters to the verifyPassword call in auth.ts:portal-credentials.
  const password = readPassword(TEST_USERS[0].email);
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  let updated = 0;
  let created = 0;

  for (const u of TEST_USERS) {
    const existing = await supabase
      .from('User')
      .select('id, role, passwordSetAt')
      .eq('email', u.email)
      .maybeSingle();

    if (existing.error && existing.error.code !== 'PGRST116') {
      console.error(`[seed-test-passwords] probe failed for ${u.email}: ${existing.error.message}`);
      process.exit(1);
    }

    if (existing.data) {
      const upd = await supabase
        .from('User')
        .update({
          passwordHash,
          passwordSetAt: now,
          role: 'client',
          updatedAt: now,
        })
        .eq('id', existing.data.id)
        .select('id, email, passwordSetAt')
        .single();
      if (upd.error) {
        console.error(`[seed-test-passwords] update failed for ${u.email}: ${upd.error.message}`);
        process.exit(1);
      }
      updated += 1;
      console.log(`[seed-test-passwords] OK ${u.email} — password refreshed (id ${upd.data.id})`);
    } else {
      const ins = await supabase
        .from('User')
        .insert({
          email: u.email,
          role: 'client',
          passwordHash,
          passwordSetAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .select('id, email, passwordSetAt')
        .single();
      if (ins.error) {
        console.error(`[seed-test-passwords] insert failed for ${u.email}: ${ins.error.message}`);
        process.exit(1);
      }
      created += 1;
      console.log(`[seed-test-passwords] OK ${u.email} — User row created (id ${ins.data.id})`);
    }
  }

  console.log('');
  console.log('[seed-test-passwords] summary:');
  console.log(`  updated : ${updated}`);
  console.log(`  created : ${created}`);
  console.log(`  total   : ${TEST_USERS.length}`);
  console.log(`  hashPrefix : ${passwordHash.slice(0, 10)}  (must be $argon2id$)`);
  console.log('');
  console.log('[seed-test-passwords] password resolution order:');
  console.log('  1. TEST_PASSWORD_<EMAIL>     (per-user override)');
  console.log('  2. TEST_PASSWORD             (legacy, all users)');
  console.log('  3. STAGING_TEST_USER_PASSWORD (canonical, KAIA-2900)');
  console.log(`  4. hard-coded default        (${DEFAULT_PASSWORD})`);
  console.log('');
  console.log('[seed-test-passwords] next step:');
  console.log('  - Set STAGING_TEST_USER_PASSWORD in the same .env the Playwright');
  console.log('    fixture sources (see portal/STAGING.md §"Test logins"), then run');
  console.log('    tests/specs/header.spec.ts against the staging portal.');
}

main().catch((err) => {
  console.error('[seed-test-passwords] crashed:', err);
  process.exit(1);
});