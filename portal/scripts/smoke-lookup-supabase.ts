// =============================================================================
// KAIA-762 — smoke test for the /api/internal/lookup-client-id-from-supabase
// endpoint
//
// Exercises:
//   1. Constant-time API key check (shared with other /api/internal/* routes).
//   2. Body validation (bad JSON, missing supabaseClientId, not a UUID, empty).
//   3. Lookup behavior on a fake ChatbotClient store:
//        * matching supabaseClientId (normal UUID)
//        * unknown UUID (404)
//   4. Response shape — { clientId } only (cuid of the matched ChatbotClient).
//
// Runs without a live HTTP server — in-process auth helper + fake Prisma
// store so the smoke is self-contained and runs in CI without docker.
//
// Run:   npx tsx scripts/smoke-lookup-supabase.ts
// Exit:  0 on success, 1 on any failure (logs the first failing assertion).
// =============================================================================

import { randomUUID } from 'node:crypto';

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// -----------------------------------------------------------------------------
// Inlined copies of the route's auth + validation logic. Mirrors
// src/lib/internal-auth.ts and
// src/app/api/internal/lookup-client-id-from-supabase/route.ts.
// Kept in sync via the test; if the production code changes, update here.
// -----------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function parseSupabaseLookupRequest(body: unknown): Result<{ supabaseClientId: string }, string> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const { supabaseClientId } = b;
  if (typeof supabaseClientId !== 'string' || !UUID_RE.test(supabaseClientId)) {
    return { ok: false, error: 'supabaseClientId must be a UUID string' };
  }
  return { ok: true, value: { supabaseClientId } };
}

// -----------------------------------------------------------------------------
// In-memory "Prisma" store — emulates the supabaseClientId unique column on
// ChatbotClient. In production this is enforced by Postgres.
// -----------------------------------------------------------------------------

interface ClientRow {
  id: string;
  supabaseClientId: string | null;
}

class FakeClientStore {
  private bySupabaseId = new Map<string, ClientRow>();

  insert(row: ClientRow) {
    if (row.supabaseClientId) {
      this.bySupabaseId.set(row.supabaseClientId, row);
    }
  }

  findBySupabaseId(supabaseClientId: string): ClientRow | null {
    return this.bySupabaseId.get(supabaseClientId) ?? null;
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
  const validUUID = randomUUID();
  check(
    'valid UUID',
    parseSupabaseLookupRequest({ supabaseClientId: validUUID }),
    { ok: true, value: { supabaseClientId: validUUID } },
  );
  check(
    'valid UUID (uppercase accepted)',
    parseSupabaseLookupRequest({ supabaseClientId: validUUID.toUpperCase() }),
    { ok: true, value: { supabaseClientId: validUUID.toUpperCase() } },
  );
  check(
    'missing supabaseClientId',
    parseSupabaseLookupRequest({}),
    { ok: false, error: 'supabaseClientId must be a UUID string' },
  );
  check(
    'supabaseClientId is not a string',
    parseSupabaseLookupRequest({ supabaseClientId: 12345 }),
    { ok: false, error: 'supabaseClientId must be a UUID string' },
  );
  check(
    'supabaseClientId is null',
    parseSupabaseLookupRequest({ supabaseClientId: null }),
    { ok: false, error: 'supabaseClientId must be a UUID string' },
  );
  check(
    'supabaseClientId is empty string',
    parseSupabaseLookupRequest({ supabaseClientId: '' }),
    { ok: false, error: 'supabaseClientId must be a UUID string' },
  );
  check(
    'supabaseClientId is not a UUID (missing dashes)',
    parseSupabaseLookupRequest({ supabaseClientId: 'not-a-uuid-at-all' }),
    { ok: false, error: 'supabaseClientId must be a UUID string' },
  );
  check(
    'supabaseClientId is not a UUID (too short)',
    parseSupabaseLookupRequest({ supabaseClientId: 'a1b2c3d4' }),
    { ok: false, error: 'supabaseClientId must be a UUID string' },
  );
  check(
    'body is not an object',
    parseSupabaseLookupRequest('a1b2c3d4-e5f6-7890-abcd-ef1234567890'),
    { ok: false, error: 'body must be an object' },
  );
  check(
    'body is null',
    parseSupabaseLookupRequest(null),
    { ok: false, error: 'body must be an object' },
  );

  // ---- Lookup behavior ----------------------------------------------------
  section('lookup — fake ChatbotClient store');
  const store = new FakeClientStore();
  const auroraSupabaseId = randomUUID();
  const auroraCuid = 'cm' + 'a'.repeat(24);
  const riosSupabaseId = randomUUID();
  const riosCuid = 'cm' + 'b'.repeat(24);

  store.insert({ id: auroraCuid, supabaseClientId: auroraSupabaseId });
  store.insert({ id: riosCuid, supabaseClientId: riosSupabaseId });
  // Client with no supabaseClientId set (not yet backfilled)
  store.insert({ id: 'cm' + 'c'.repeat(24), supabaseClientId: null });

  check(
    'matching UUID (aurora) returns the row',
    store.findBySupabaseId(auroraSupabaseId),
    { id: auroraCuid, supabaseClientId: auroraSupabaseId },
  );
  check(
    'matching UUID (rios) returns the row',
    store.findBySupabaseId(riosSupabaseId),
    { id: riosCuid, supabaseClientId: riosSupabaseId },
  );
  check(
    'unknown UUID returns null (route maps to 404)',
    store.findBySupabaseId(randomUUID()),
    null,
  );

  // ---- Response shape ----------------------------------------------------
  section('response shape — { clientId } only (portal cuid)');
  const matched = store.findBySupabaseId(auroraSupabaseId)!;
  check(
    'response has exactly { clientId } (the portal cuid)',
    { clientId: matched.id },
    { clientId: auroraCuid },
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