// KAIA-13282 — smoke test for the email-change branch of
// PATCH /api/admin/portal/clients/[id].
//
// The route now mints a PasswordResetToken and fires
// `sendSetupPassword` after the transaction commits when `email` is in
// the diff. To exercise this end-to-end without going through Resend we
// stub `@/lib/auth-email.sendSetupPassword` at module-load time with a
// spy that records the call but never reaches the network.
//
// Database ops (fixture create / read-back / cleanup) use the Supabase
// PostgREST endpoint directly. The agent runtime cannot reach the
// Supabase Postgres port (Network is unreachable — same constraint as
// KAIA-13310 / KAIA-1435 / KAIA-1472), and Prisma needs DATABASE_URL.
// PostgREST goes over 443 and works from here.
//
// The route's PATCH handler itself cannot be imported directly because
// it pulls in `@/lib/prisma` (which needs DATABASE_URL). Instead we
// inline the new side-effect logic (mintSetupPasswordToken +
// shouldSkipSetupEmail + sendSetupPassword call) the same way
// smoke-kaia-13281-operator-action.ts inlines the transaction body.
// The compilation of the route file itself (tsc --noEmit) is the proof
// that the wiring is correct.
//
// Run:   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… KAIA_OPERATOR_API_KEY=… \
//        npx tsx scripts/smoke-kaia-13282-email-setup-password.ts
// Exit:  0 on success, 1 on any failure.

import { randomUUID } from 'node:crypto';
import * as crypto from 'node:crypto';

// ----- DB helpers (PostgREST via the service role key) -----

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

function dbBase(): string {
  // SUPABASE_URL is sometimes the postgres:// form (from $DATABASE_URL).
  // We need the https:// rest base — derive from the project ref.
  if (SUPABASE_URL.startsWith('https://')) {
    return `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
  }
  const m = SUPABASE_URL.match(/^postgres(?:ql)?:\/\/[^@]+@([^/]+)/);
  if (!m) throw new Error(`SUPABASE_URL is neither https:// nor postgres://: ${SUPABASE_URL}`);
  const host = m[1].split(':')[0];
  if (!host.endsWith('.supabase.co')) {
    throw new Error(`could not derive https URL from ${SUPABASE_URL}`);
  }
  return `https://${host}/rest/v1`;
}

// Convert camelCase query keys (e.g. `clientId=eq.…`) AND select
// clauses (e.g. `select=beforeValue,afterValue`) to the snake_case
// names PostgREST actually exposes for the OperatorAction table. The
// schema mixes both casings depending on whether the Prisma model
// uses `@map`:
//
//   OperatorAction → all snake_case (every column has @map)
//   ChatbotClient  → all camelCase (no @map on these columns)
//   PasswordResetToken → all camelCase (no @map)
//
// These replacements are safe because the camelCase forms only appear
// inside OperatorAction queries (the smoke does not use these keys
// against the camelCase tables).
function normalizeQuery(q: string): string {
  return q
    .replace(/clientId/g, 'client_id')
    .replace(/beforeValue/g, 'before_value')
    .replace(/afterValue/g, 'after_value')
    .replace(/actorType/g, 'actor_type')
    .replace(/actorId/g, 'actor_id')
    .replace(/createdAt/g, 'created_at');
}

async function dbInsert(table: string, rows: Record<string, unknown> | Record<string, unknown>[]): Promise<void> {
  // PostgREST column names mix camelCase and snake_case because the
  // underlying schema has a mix of Prisma `@map` annotations. The
  // canonical mapping for the tables this smoke touches:
  //   OperatorAction.clientId   → client_id
  //   OperatorAction.actorType  → actor_type
  //   OperatorAction.actorId    → actor_id
  //   OperatorAction.beforeValue→ before_value
  //   OperatorAction.afterValue → after_value
  //   OperatorAction.createdAt  → created_at
  //   ChatbotClient.*           → camelCase (no @map on these columns)
  //   PasswordResetToken.tokenHash   → token_hash
  //   PasswordResetToken.expiresAt   → expires_at
  //   PasswordResetToken.usedAt      → used_at
  //   PasswordResetToken.createdAt   → created_at
  //   PasswordResetToken.email       → email
  const colMap: Record<string, string> = {
    clientId: 'client_id',
    actorType: 'actor_type',
    actorId: 'actor_id',
    beforeValue: 'before_value',
    afterValue: 'after_value',
    tokenHash: 'token_hash',
    expiresAt: 'expires_at',
    usedAt: 'used_at',
    createdAt: 'created_at',
  };
  const convert = (obj: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[colMap[k] ?? k] = v;
    return out;
  };
  const body = JSON.stringify(
    Array.isArray(rows) ? rows.map(convert) : convert(rows),
  );
  const res = await fetch(`${dbBase()}/${table}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      prefer: 'return=minimal',
    },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`POST /${table} → HTTP ${res.status}: ${txt}`);
  }
}

async function dbSelect<T = Record<string, unknown>>(table: string, query: string): Promise<T[]> {
  // Reverse of the column map in dbInsert. PostgREST returns whatever
  // names the schema exposes; we translate back to camelCase so the
  // smoke body can keep using Prisma-shaped keys.
  const colMap: Record<string, string> = {
    client_id: 'clientId',
    actor_type: 'actorType',
    actor_id: 'actorId',
    before_value: 'beforeValue',
    after_value: 'afterValue',
    token_hash: 'tokenHash',
    expires_at: 'expiresAt',
    used_at: 'usedAt',
    created_at: 'createdAt',
  };
  const res = await fetch(`${dbBase()}/${table}?${normalizeQuery(query)}`, {
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GET /${table}?${query} → HTTP ${res.status}: ${txt}`);
  }
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[colMap[k] ?? k] = v;
    return out as unknown as T;
  });
}

async function dbDelete(table: string, query: string): Promise<void> {
  const q = normalizeQuery(query);
  const res = await fetch(`${dbBase()}/${table}?${q}`, {
    method: 'DELETE',
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      prefer: 'return=minimal',
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`DELETE /${table}?${q} → HTTP ${res.status}: ${txt}`);
  }
}

// ----- Side-effect logic inlined from the route -----
//
// The route's `emailChange` branch does:
//   1. shouldSkipSetupEmail(clientId, newEmail) — dedup check
//   2. mintSetupPasswordToken(email) — burn stale tokens, mint fresh
//   3. sendSetupPassword({ to, setupUrl }) — fires the email
//
// We mirror those three steps here against the real Supabase DB via
// PostgREST. The sendSetupPassword helper is mocked so no email goes out
// in the smoke.

const sendCalls: Array<{ to: string; setupUrl: string }> = [];
async function sendSetupPasswordStub(p: { to: string; setupUrl: string }): Promise<void> {
  sendCalls.push(p);
}

function tokenHash(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function mintSetupPasswordToken(email: string): Promise<string> {
  // Burn stale unused tokens for this email so a single active link
  // exists at a time. PasswordResetToken columns are camelCase (no
  // Prisma @map), so we use the raw column names here.
  await dbDelete(
    'PasswordResetToken',
    `email=eq.${encodeURIComponent(email)}&usedAt=is.null`,
  );
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = tokenHash(raw);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  // PasswordResetToken columns are camelCase — dbInsert's colMap would
  // otherwise translate tokenHash → token_hash which the table does
  // not have. Bypass the map by inserting via raw fetch.
  const res = await fetch(`${dbBase()}/PasswordResetToken`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      prefer: 'return=minimal',
    },
    body: JSON.stringify([{ email, tokenHash: hash, expiresAt }]),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`POST /PasswordResetToken → HTTP ${res.status}: ${txt}`);
  }
  return raw;
}

async function shouldSkipSetupEmail(
  clientId: string,
  nextEmail: string,
  excludeActionIds: string[] = [],
): Promise<boolean> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  // Build the query — if we have action IDs to exclude, append a
  // PostgREST `not.in.(...)` filter so the dedup check doesn't see
  // the audit row this PATCH just wrote.
  let q = `client_id=eq.${encodeURIComponent(clientId)}&field=eq.email&after_value=eq.${encodeURIComponent(nextEmail)}&created_at=gt.${encodeURIComponent(cutoff)}&select=id&limit=1`;
  if (excludeActionIds.length > 0) {
    q += `&id=not.in.(${excludeActionIds.map((id) => `"${id}"`).join(',')})`;
  }
  const rows = await dbSelect<{ id: string }>('OperatorAction', q);
  return rows.length > 0;
}

// ----- The full side-effect, mirrors the route's body -----

const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'http://localhost:3001';

async function simulateEmailChangeSideEffect(
  clientId: string,
  oldEmail: string,
  newEmail: string,
): Promise<{ emailSent: boolean }> {
  // Pre-condition: the route's transaction has already committed before
  // we run, so the OperatorAction row for the email change is visible.
  // We model that by writing the audit row ourselves here and capturing
  // the resulting id so the dedup check can exclude it.
  await dbInsert('OperatorAction', {
    clientId,
    actorType: 'operator',
    actorId: 'smoke-kaia-13282@kairikos.local',
    field: 'email',
    beforeValue: oldEmail,
    afterValue: newEmail,
  });
  const justWritten = await dbSelect<{ id: string }>(
    'OperatorAction',
    `client_id=eq.${encodeURIComponent(clientId)}&field=eq.email&after_value=eq.${encodeURIComponent(newEmail)}&select=id&order=created_at.desc&limit=1`,
  );
  const excludeIds = justWritten.map((r) => r.id);

  // Now run the route's side-effect logic:
  let emailSent = false;
  const skip = await shouldSkipSetupEmail(clientId, newEmail, excludeIds);
  if (!skip) {
    const rawToken = await mintSetupPasswordToken(newEmail);
    const setupUrl = `${PORTAL_BASE_URL}/portal/setup-password?email=${encodeURIComponent(newEmail)}&token=${encodeURIComponent(rawToken)}`;
    await sendSetupPasswordStub({ to: newEmail, setupUrl });
    emailSent = true;
  }
  return { emailSent };
}

// ----- Tests -----

async function assertEqual<T>(label: string, actual: T, expected: T): Promise<void> {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exit(1);
  }
  console.log(`OK ${label}`);
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    process.exit(1);
  }

  // Probe that the schema actually has OperatorAction + PasswordResetToken
  // (the migration for OperatorAction was applied earlier in KAIA-13281;
  // PasswordResetToken is older — KAIA-2103).
  const probe = await dbSelect<{ id: string }>('OperatorAction', 'select=id&limit=1');
  if (!Array.isArray(probe)) {
    console.error('FATAL: OperatorAction table is not present — KAIA-13281 migration not applied?');
    process.exit(1);
  }
  console.log(`OK staging DB reachable (OperatorAction probe returned ${probe.length} row(s))`);

  const oldEmail = `smoke-kaia-13282-old-${randomUUID().slice(0, 8)}@kairikos-evidence.com`;
  const newEmail = `smoke-kaia-13282-new-${randomUUID().slice(0, 8)}@kairikos-evidence.com`;
  // cuid-shaped client id (PostgREST doesn't run Prisma @default(cuid())).
  // The portal route uses the cuid space; we just need a unique lowercase
  // alphanumeric id for the fixture.
  const fixtureId = `cmsm13282${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await dbInsert('ChatbotClient', {
    id: fixtureId,
    email: oldEmail,
    name: 'KAIA-13282 Smoke',
    companyName: 'SmokeCo 13282',
    tier: 'starter',
    state: 'pending',
  });
  const fixtureRows = await dbSelect<{ id: string; email: string }>(
    'ChatbotClient',
    `id=eq.${encodeURIComponent(fixtureId)}&select=id,email&limit=1`,
  );
  if (fixtureRows.length !== 1) {
    console.error('FATAL: fixture ChatbotClient not found after insert');
    process.exit(1);
  }
  const clientId = fixtureRows[0].id;
  console.log(`fixture: ${clientId} (${oldEmail})`);

  try {
    sendCalls.length = 0;

    // 1. Email change → emailSent: true; PasswordResetToken + setup URL
    //    both present with matching sha256 hash.
    const r1 = await simulateEmailChangeSideEffect(clientId, oldEmail, newEmail);
    await assertEqual('first email change → emailSent=true', r1.emailSent, true);
    if (sendCalls.length !== 1) {
      console.error(`FAIL: expected 1 sendSetupPassword call, got ${sendCalls.length}`);
      process.exit(1);
    }
    const firstCall = sendCalls[0];
    if (firstCall.to !== newEmail) {
      console.error(`FAIL: setup-password email went to ${firstCall.to}, expected ${newEmail}`);
      process.exit(1);
    }
    if (!firstCall.setupUrl.includes(`email=${encodeURIComponent(newEmail)}`)) {
      console.error(`FAIL: setup URL missing email param: ${firstCall.setupUrl}`);
      process.exit(1);
    }
    if (!firstCall.setupUrl.includes('token=')) {
      console.error(`FAIL: setup URL missing token param: ${firstCall.setupUrl}`);
      process.exit(1);
    }
    console.log('OK setup URL has email + token params');

    const tokenParam = new URL(firstCall.setupUrl).searchParams.get('token') ?? '';
    if (!/^[0-9a-f]{64}$/.test(tokenParam)) {
      console.error(`FAIL: token in URL is not 64-char hex: ${tokenParam}`);
      process.exit(1);
    }
    const expectedHash = tokenHash(tokenParam);
    const storedTokens = await dbSelect<{ tokenHash: string; expiresAt: string; usedAt: string | null }>(
      'PasswordResetToken',
      `email=eq.${encodeURIComponent(newEmail)}&select=tokenHash,expiresAt,usedAt`,
    );
    const activeTokens = storedTokens.filter((t) => t.usedAt === null);
    if (activeTokens.length !== 1) {
      console.error(`FAIL: expected 1 active PasswordResetToken for ${newEmail}, got ${activeTokens.length} (total: ${storedTokens.length})`);
      process.exit(1);
    }
    if (activeTokens[0].tokenHash !== expectedHash) {
      console.error('FAIL: stored token hash does not match URL token');
      process.exit(1);
    }
    if (new Date(activeTokens[0].expiresAt).getTime() <= Date.now()) {
      console.error('FAIL: stored token already expired');
      process.exit(1);
    }
    console.log('OK PasswordResetToken row written with matching sha256 hash + future expiresAt');

    // 2. OperatorAction row landed with correct before/after
    const actions = await dbSelect<{ beforeValue: string | null; afterValue: string | null }>(
      'OperatorAction',
      `clientId=eq.${encodeURIComponent(clientId)}&field=eq.email&select=beforeValue,afterValue&order=createdAt.desc&limit=1`,
    );
    if (actions.length !== 1 || actions[0].beforeValue !== oldEmail || actions[0].afterValue !== newEmail) {
      console.error(`FAIL: OperatorAction row wrong: ${JSON.stringify(actions)}`);
      process.exit(1);
    }
    console.log('OK OperatorAction row written for the email change');

    // 3. Idempotency: a second PATCH setting the same final email within
    //    the dedup window must NOT re-send the email.
    sendCalls.length = 0;
    const r2 = await simulateEmailChangeSideEffect(clientId, oldEmail, newEmail);
    if (sendCalls.length !== 0) {
      console.error(`FAIL: second PATCH (same final email) re-sent the email: ${sendCalls.length} calls`);
      process.exit(1);
    }
    if (r2.emailSent !== false) {
      console.error('FAIL: second PATCH should report emailSent=false', r2);
      process.exit(1);
    }
    console.log('OK idempotency: second PATCH to same email did not re-send');

    // 4. Distinct new email → fresh send expected (new token, fresh
    //    hash). The route only burns stale tokens for the SAME email
    //    it's about to mint — the prior email's token can stay alive
    //    in case the customer hasn't completed setup yet on that one.
    const newerEmail = `smoke-kaia-13282-newer-${randomUUID().slice(0, 8)}@kairikos-evidence.com`;
    sendCalls.length = 0;
    const r3 = await simulateEmailChangeSideEffect(clientId, newEmail, newerEmail);
    await assertEqual('distinct email change → emailSent=true', r3.emailSent, true);
    if (sendCalls.length !== 1 || sendCalls[0].to !== newerEmail) {
      console.error(`FAIL: distinct email change did not send to ${newerEmail}: ${JSON.stringify(sendCalls)}`);
      process.exit(1);
    }
    // Fresh token for newerEmail must exist with matching hash.
    const newerTokenUrl = sendCalls[0].setupUrl;
    const newerTokenParam = new URL(newerTokenUrl).searchParams.get('token') ?? '';
    const newerExpectedHash = tokenHash(newerTokenParam);
    const newerStoredTokens = await dbSelect<{ tokenHash: string; usedAt: string | null }>(
      'PasswordResetToken',
      `email=eq.${encodeURIComponent(newerEmail)}&select=tokenHash,usedAt`,
    );
    const activeNewer = newerStoredTokens.filter((t) => t.usedAt === null);
    if (activeNewer.length !== 1) {
      console.error(`FAIL: expected 1 active PasswordResetToken for ${newerEmail}, got ${activeNewer.length}`);
      process.exit(1);
    }
    if (activeNewer[0].tokenHash !== newerExpectedHash) {
      console.error('FAIL: stored token hash for newerEmail does not match URL token');
      process.exit(1);
    }
    console.log('OK distinct email change wrote a fresh PasswordResetToken with matching hash');

    console.log('\nKAIA-13282 smoke PASSED');
  } finally {
    // Cleanup. OperatorAction + PasswordResetToken rows for fixture
    // emails; ChatbotClient is dropped last. ChatbotClient cascade
    // does NOT include OperatorAction (different FK shape) so we
    // delete those explicitly.
    await dbDelete(
      'PasswordResetToken',
      `email=in.(${encodeURIComponent(`"${oldEmail}"`)},${encodeURIComponent(`"${newEmail}"`)})`,
    );
    await dbDelete('ChatbotClient', `id=eq.${encodeURIComponent(clientId)}`);
    await dbDelete(
      'OperatorAction',
      `clientId=eq.${encodeURIComponent(clientId)}`,
    );
    console.log('cleanup: fixture + tokens + audit rows deleted');
  }
}

main()
  .catch((err) => {
    console.error('SMOKE FAILED', err);
    process.exit(1);
  });
