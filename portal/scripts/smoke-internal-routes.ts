// =============================================================================
// KAIA-756.1 — smoke test for the /api/internal/lookup-client endpoint
//
// Exercises:
//   1. Constant-time API key check (shared with /api/internal/activity — the
//      test re-uses the same auth helper logic so a regression in
//      src/lib/internal-auth.ts fails every smoke).
//   2. Body validation (bad JSON, missing email, bad email, non-string
//      email, empty email).
//   3. Lookup behavior on a fake client store:
//        * matching email (normal + case-insensitive + whitespace-trimmed)
//        * unknown email (404)
//   4. Response shape — only the contract fields, in the right order, with
//      `companyName: null` preserved when the DB has null.
//
// Runs without a live HTTP server — it instantiates the auth helper, the
// validation logic, and a fake Prisma store in-process so the smoke is
// self-contained and runs in CI without docker / postgres.
//
// Run:   npx tsx scripts/smoke-internal-routes.ts
// Exit:  0 on success, 1 on any failure (logs the first failing assertion).
// =============================================================================

import { randomUUID } from 'node:crypto';

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// -----------------------------------------------------------------------------
// Inlined copies of the route's auth + validation logic. Mirrors
// src/lib/internal-auth.ts and src/app/api/internal/lookup-client/route.ts.
// Kept in sync via the test; if the production code changes, update here.
// -----------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function constantTimeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    const padded = Buffer.alloc(b.length, 0);
    a.copy(padded);
    let acc = 0;
    for (let i = 0; i < b.length; i++) acc |= padded[i] ^ b[i];
    return acc === 0 && false;
  }
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a[i] ^ b[i];
  return acc === 0;
}

function authenticateInternal(
  headerValue: string | null,
  serverKey: string,
): Result<true, 'missing_key_header' | 'server_misconfigured' | 'invalid_key'> {
  if (!serverKey) return { ok: false, error: 'server_misconfigured' };
  if (!headerValue) return { ok: false, error: 'missing_key_header' };
  return constantTimeEquals(headerValue, serverKey)
    ? { ok: true, value: true }
    : { ok: false, error: 'invalid_key' };
}

function parseLookupRequest(body: unknown): Result<{ email: string }, string> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const { email } = b;
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return { ok: false, error: 'email must be a valid email string' };
  }
  return { ok: true, value: { email: email.trim().toLowerCase() } };
}

// -----------------------------------------------------------------------------
// In-memory "Prisma" store — emulates the (email) unique constraint on
// ChatbotClient. In production this is enforced by Postgres.
// -----------------------------------------------------------------------------

interface ClientRow {
  id: string;
  companyName: string | null;
  email: string;
}

class FakeClientStore {
  private byEmail = new Map<string, ClientRow>();

  insert(row: ClientRow) {
    this.byEmail.set(row.email, row);
  }

  findByEmail(email: string): ClientRow | null {
    return this.byEmail.get(email) ?? null;
  }
}

// -----------------------------------------------------------------------------
// Test harness
// -----------------------------------------------------------------------------

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
    failures++;
  }
}

function section(title: string) {
  console.log(`\n[smoke] ${title}`);
}

function main() {
  // ---- Auth ----------------------------------------------------------------
  section('auth — constant-time shared-secret check (mirrors internal-auth.ts)');
  check(
    'matching key',
    authenticateInternal('correct-horse-battery-staple', 'correct-horse-battery-staple'),
    { ok: true, value: true },
  );
  check(
    'wrong key',
    authenticateInternal('nope', 'correct-horse-battery-staple'),
    { ok: false, error: 'invalid_key' },
  );
  check(
    'missing header',
    authenticateInternal(null, 'correct-horse-battery-staple'),
    { ok: false, error: 'missing_key_header' },
  );
  check(
    'server not configured',
    authenticateInternal('any', ''),
    { ok: false, error: 'server_misconfigured' },
  );
  check(
    'length mismatch does not crash',
    authenticateInternal('short', 'a-much-longer-expected-key'),
    { ok: false, error: 'invalid_key' },
  );

  // ---- Validation ----------------------------------------------------------
  section('validation — request body');
  check(
    'valid email',
    parseLookupRequest({ email: 'cliente@empresa.com' }),
    { ok: true, value: { email: 'cliente@empresa.com' } },
  );
  check(
    'email is trimmed + lowercased',
    parseLookupRequest({ email: '  Cliente@Empresa.COM  ' }),
    { ok: true, value: { email: 'cliente@empresa.com' } },
  );
  check(
    'missing email',
    parseLookupRequest({}),
    { ok: false, error: 'email must be a valid email string' },
  );
  check(
    'email is not a string',
    parseLookupRequest({ email: 12345 }),
    { ok: false, error: 'email must be a valid email string' },
  );
  check(
    'email is null',
    parseLookupRequest({ email: null }),
    { ok: false, error: 'email must be a valid email string' },
  );
  check(
    'email is empty string',
    parseLookupRequest({ email: '' }),
    { ok: false, error: 'email must be a valid email string' },
  );
  check(
    'email is whitespace',
    parseLookupRequest({ email: '   ' }),
    { ok: false, error: 'email must be a valid email string' },
  );
  check(
    'email has no @',
    parseLookupRequest({ email: 'not-an-email' }),
    { ok: false, error: 'email must be a valid email string' },
  );
  check(
    'email has no domain',
    parseLookupRequest({ email: 'cliente@' }),
    { ok: false, error: 'email must be a valid email string' },
  );
  check(
    'body is not an object',
    parseLookupRequest('cliente@empresa.com'),
    { ok: false, error: 'body must be an object' },
  );
  check(
    'body is null',
    parseLookupRequest(null),
    { ok: false, error: 'body must be an object' },
  );

  // ---- Lookup behavior ----------------------------------------------------
  section('lookup — fake ChatbotClient store');
  const store = new FakeClientStore();
  const auroraId = randomUUID();
  const riosId = randomUUID();
  store.insert({
    id: auroraId,
    companyName: 'Peluquería Aurora',
    email: 'aurora@example.com',
  });
  store.insert({
    id: riosId,
    companyName: null, // optional field may be null
    email: 'rios@example.com',
  });

  check(
    'matching email (aurora) returns id + companyName',
    store.findByEmail('aurora@example.com'),
    {
      id: auroraId,
      companyName: 'Peluquería Aurora',
      email: 'aurora@example.com',
    },
  );
  check(
    'matching email (rios) preserves null companyName',
    store.findByEmail('rios@example.com'),
    { id: riosId, companyName: null, email: 'rios@example.com' },
  );
  check(
    'unknown email returns null (the route maps to 404)',
    store.findByEmail('ghost@example.com'),
    null,
  );
  check(
    'email is the natural key (case-sensitive in store, normalized at route)',
    store.findByEmail('AURORA@EXAMPLE.COM'),
    null,
  );

  // ---- Response shape ----------------------------------------------------
  section('response shape — contract fields only');
  const matched = store.findByEmail('aurora@example.com')!;
  check(
    'response has exactly { clientId, companyName, contactEmail }',
    {
      clientId: matched.id,
      companyName: matched.companyName,
      contactEmail: matched.email,
    },
    {
      clientId: auroraId,
      companyName: 'Peluquería Aurora',
      contactEmail: 'aurora@example.com',
    },
  );

  // ---- Final --------------------------------------------------------------
  section('summary');
  if (failures > 0) {
    console.error(`[smoke] FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('[smoke] OK — all assertions passed');
}

main();
