// =============================================================================
// KAIA-1585 — Staging Operator seed.
//
// Seeds one row into the portal Prisma `Operator` table in the staging
// Supabase DB so QA can drive the operator login smoke on KAIA-1254.
//
// Why a Supabase REST script (and not `prisma db execute` / direct Postgres)
// ---------------------------------------------------------------------------
// The agent runtime cannot reach `db.ikexqreuvoqwvwopftkt.supabase.co:5432`
// directly (`Network is unreachable` — see KAIA-1435, KAIA-1472). The
// Supabase REST API goes over HTTPS on 443 and is reachable from here, so
// this script uses `@supabase/supabase-js` with the service role key.
//
// Idempotent
// ----------
// Re-running this script is a no-op. The script:
//   1. SELECTs by `email` first.
//   2. If a row exists, UPDATEs `passwordHash` + `updatedAt` and exits.
//   3. If not, INSERTs a new row with a freshly-minted UUID v4 id.
//
// Secrets
// -------
// The plaintext password is NEVER hard-coded. The script reads it from
// `OPS_STAGING_OPERATOR_PASSWORD` at runtime. The 1Password reference is
// documented in `docs/seed-staging-operator.md`.
//
// Run from the project root:
//
//   cd /paperclip/instances/default/projects/fe217b5c-badf-4f17-ab20-f089478a35c7/bbe7754b-a8a8-4e1d-86b6-8cbbc4cfa3a4/_default/portal
//   SUPABASE_URL=https://ikexqreuvoqwvwopftkt.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
//   OPS_STAGING_OPERATOR_EMAIL=ops-staging@kairikos.com \
//   OPS_STAGING_OPERATOR_PASSWORD='<value from 1Password>' \
//     npx tsx scripts/seed-staging-operator.ts
//
// Exit: 0 on success, 1 on any error.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { hashPassword } from '../src/lib/operator-crypto';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[seed-staging-operator] FATAL: env var ${name} is not set.`);
    console.error('See docs/seed-staging-operator.md for the runbook.');
    process.exit(1);
  }
  return v;
}

const DEFAULT_EMAIL = 'ops-staging@kairikos.com';

async function main(): Promise<void> {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const email = process.env.OPS_STAGING_OPERATOR_EMAIL ?? DEFAULT_EMAIL;
  const password = requireEnv('OPS_STAGING_OPERATOR_PASSWORD');

  if (email !== email.toLowerCase().trim()) {
    console.error(`[seed-staging-operator] FATAL: email must be lowercase (got "${email}").`);
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Probe — is the row already there?
  const probe = await supabase
    .from('Operator')
    .select('id, email, isActive, totpEnrolledAt, lastLoginAt, lastTotpAt')
    .eq('email', email)
    .maybeSingle();

  if (probe.error && probe.error.code !== 'PGRST116') {
    console.error(`[seed-staging-operator] probe failed: ${probe.error.message}`);
    process.exit(1);
  }

  // 2. Hash the password (argon2id) — same params the auth lib uses on the
  //    request path, so the stored hash verifies with `verifyPassword`.
  //    Never log `passwordHash` or `password` to stdout/stderr.
  const passwordHash = await hashPassword(password);

  const now = new Date().toISOString();

  if (probe.data) {
    // 3a. Update existing row in place — keep id, refresh hash + updatedAt.
    const upd = await supabase
      .from('Operator')
      .update({
        passwordHash,
        isActive: true,
        updatedAt: now,
      })
      .eq('id', probe.data.id)
      .select('id, email, isActive, updatedAt')
      .single();

    if (upd.error) {
      console.error(`[seed-staging-operator] update failed: ${upd.error.message}`);
      process.exit(1);
    }
    console.log('[seed-staging-operator] OK (updated existing row)');
    console.log(`  id          : ${upd.data.id}`);
    console.log(`  email       : ${upd.data.email}`);
    console.log(`  isActive    : ${upd.data.isActive}`);
    console.log(`  updatedAt   : ${upd.data.updatedAt}`);
    console.log('  passwordHash: <redacted>');
    return;
  }

  // 3b. Insert — mint a UUID v4 (the SQL `id` column has no DEFAULT).
  const id = randomUUID();
  const ins = await supabase
    .from('Operator')
    .insert({
      id,
      email,
      passwordHash,
      isActive: true,
      // createdAt / updatedAt have DEFAULT now() in the SQL, but Prisma
      // treats the camelCase columns as required, so we send them.
      createdAt: now,
      updatedAt: now,
      // totpSecret / totpEnrolledAt / lastLoginAt / lastTotpAt are nullable
      // in the schema; leaving them unset is intentional for the v1 smoke
      // (the smoke does not exercise TOTP — see issue body, "Out of scope").
    })
    .select('id, email, isActive, createdAt, updatedAt')
    .single();

  if (ins.error) {
    console.error(`[seed-staging-operator] insert failed: ${ins.error.message}`);
    if (ins.error.code === '23505') {
      console.error(
        '  unique violation on email — another process may have inserted concurrently. Re-run.',
      );
    }
    process.exit(1);
  }
  console.log('[seed-staging-operator] OK (inserted new row)');
  console.log(`  id          : ${ins.data.id}`);
  console.log(`  email       : ${ins.data.email}`);
  console.log(`  isActive    : ${ins.data.isActive}`);
  console.log(`  createdAt   : ${ins.data.createdAt}`);
  console.log(`  updatedAt   : ${ins.data.updatedAt}`);
  console.log('  passwordHash: <redacted>');
}

main().catch((err) => {
  console.error('[seed-staging-operator] crashed:', err);
  process.exit(1);
});
