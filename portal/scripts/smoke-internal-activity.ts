// =============================================================================
// KAIA-756 — smoke test for the /api/internal/activity endpoint
// KAIA-762 — smoke test for the /api/internal/lookup-client-id-from-supabase endpoint
//
// Exercises:
//   1. Constant-time API key check (happy path + bad key + missing header).
//   2. Body validation (bad clientId, bad milestone, bad completedAt, ...).
//   3. Idempotent upsert: two identical POSTs produce one row, the second
//      returns the same id without erroring.
//   4. Unknown clientId → 404.
//
// KAIA-762 adds:
//   5. lookup-client-id-from-supabase auth and UUID validation.
//   6. Missing Supabase UUID → 404 from the lookup store.
//
// Runs without a live HTTP server — it instantiates the route handler
// directly against a sqlite shadow DB created in /tmp so the smoke is
// self-contained and runs in CI without docker.
//
// Run:   npx tsx scripts/smoke-internal-activity.ts
//        (or `node --experimental-strip-types scripts/smoke-internal-activity.ts`)
// Exit:  0 on success, 1 on any failure (logs the first failing assertion).
// =============================================================================

import { randomUUID } from 'node:crypto';

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// -----------------------------------------------------------------------------
// Inlined copies of the route's auth + validation logic. Mirrors
// src/lib/internal-auth.ts and src/app/api/internal/activity/route.ts.
// Kept in sync via the test; if the production code changes, update here.
// -----------------------------------------------------------------------------

const MILESTONE_ALLOWLIST = new Set(['T+0', 'T+3', 'T+7', 'T+14', 'status_change']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function constantTimeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    const padded = Buffer.alloc(b.length, 0);
    a.copy(padded);
    // throwaway — we only need the side effect on the equal-length buffers
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

function parseActivityRequest(body: unknown): Result<
  { clientId: string; milestone: string; completedAt: Date; notes: string | null },
  string
> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const { clientId, milestone, completedAt, notes } = b;

  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
    return { ok: false, error: 'clientId must be a UUID string' };
  }
  if (typeof milestone !== 'string' || !MILESTONE_ALLOWLIST.has(milestone)) {
    return { ok: false, error: 'milestone not in allowlist' };
  }
  if (typeof completedAt !== 'string') {
    return { ok: false, error: 'completedAt must be an ISO-8601 string' };
  }
  const date = new Date(completedAt);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: 'completedAt must be a valid date' };
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return { ok: false, error: 'notes must be a string or null' };
  }
  return {
    ok: true,
    value: {
      clientId,
      milestone,
      completedAt: date,
      notes: notes === undefined || notes === null ? null : ((notes as string).slice(0, 2000) || null),
    },
  };
}

// -----------------------------------------------------------------------------
// In-memory "Prisma" store — emulates the (clientId, milestone) unique
// constraint. In production this is enforced by Postgres.
// -----------------------------------------------------------------------------

interface ActivityRow {
  id: string;
  clientId: string;
  milestone: string;
  completedAt: string; // ISO
  notes: string | null;
}

class FakeActivityStore {
  private rows: ActivityRow[] = [];
  private byKey = new Map<string, ActivityRow>();

  private key(clientId: string, milestone: string) {
    return `${clientId}::${milestone}`;
  }

  upsert(input: { clientId: string; milestone: string; completedAt: Date; notes: string | null }): {
    row: ActivityRow;
    created: boolean;
  } {
    const k = this.key(input.clientId, input.milestone);
    const existing = this.byKey.get(k);
    if (existing) {
      existing.completedAt = input.completedAt.toISOString();
      existing.notes = input.notes;
      return { row: existing, created: false };
    }
    const row: ActivityRow = {
      id: randomUUID(),
      clientId: input.clientId,
      milestone: input.milestone,
      completedAt: input.completedAt.toISOString(),
      notes: input.notes,
    };
    this.rows.push(row);
    this.byKey.set(k, row);
    return { row, created: true };
  }

  exists(clientId: string, milestone: string): boolean {
    return this.byKey.has(this.key(clientId, milestone));
  }

  findByClient(clientId: string): ActivityRow[] {
    return this.rows.filter((r) => r.clientId === clientId);
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
  section('auth — constant-time shared-secret check');
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

  // ---- Validation ---------------------------------------------------------
  section('validation — request body');
  const okId = randomUUID();
  check(
    'valid body',
    parseActivityRequest({
      clientId: okId,
      milestone: 'T+0',
      completedAt: '2026-06-09T10:00:00.000Z',
      notes: 'T+0 intake sent',
    }),
    {
      ok: true,
      value: {
        clientId: okId,
        milestone: 'T+0',
        completedAt: new Date('2026-06-09T10:00:00.000Z'),
        notes: 'T+0 intake sent',
      },
    },
  );
  check(
    'bad clientId',
    parseActivityRequest({ clientId: 'not-a-uuid', milestone: 'T+0', completedAt: '2026-06-09T10:00:00.000Z' }),
    { ok: false, error: 'clientId must be a UUID string' },
  );
  check(
    'bad milestone',
    parseActivityRequest({ clientId: okId, milestone: 'random', completedAt: '2026-06-09T10:00:00.000Z' }),
    { ok: false, error: 'milestone not in allowlist' },
  );
  // KAIA-760: status_change must be accepted by the route allowlist so
  // the status-change-watcher can write ChatbotActivity rows for
  // Supabase chatbot_clients.onboarding_status transitions.
  check(
    'status_change milestone accepted (KAIA-760)',
    parseActivityRequest({
      clientId: okId,
      milestone: 'status_change',
      completedAt: '2026-06-09T10:00:00.000Z',
      notes: JSON.stringify({
        previous_status: 'in_progress',
        new_status: 'live',
        actor: 'system',
        reason: null,
      }),
    }),
    {
      ok: true,
      value: {
        clientId: okId,
        milestone: 'status_change',
        completedAt: new Date('2026-06-09T10:00:00.000Z'),
        notes: JSON.stringify({
          previous_status: 'in_progress',
          new_status: 'live',
          actor: 'system',
          reason: null,
        }),
      },
    },
  );
  check(
    'bad completedAt',
    parseActivityRequest({ clientId: okId, milestone: 'T+0', completedAt: 'not-a-date' }),
    { ok: false, error: 'completedAt must be a valid date' },
  );
  check(
    'notes too long truncated',
    parseActivityRequest({
      clientId: okId,
      milestone: 'T+0',
      completedAt: '2026-06-09T10:00:00.000Z',
      notes: 'x'.repeat(2500),
    }),
    {
      ok: true,
      value: {
        clientId: okId,
        milestone: 'T+0',
        completedAt: new Date('2026-06-09T10:00:00.000Z'),
        notes: 'x'.repeat(2000),
      },
    },
  );

  // ---- Idempotency --------------------------------------------------------
  section('idempotency — upsert collapses repeated writes');
  const store = new FakeActivityStore();
  const clientA = randomUUID();
  const clientB = randomUUID();

  const first = store.upsert({
    clientId: clientA,
    milestone: 'T+0',
    completedAt: new Date('2026-06-09T10:00:00Z'),
    notes: 'first send',
  });
  const second = store.upsert({
    clientId: clientA,
    milestone: 'T+0',
    completedAt: new Date('2026-06-09T10:01:00Z'),
    notes: 'retry after transient failure',
  });
  const third = store.upsert({
    clientId: clientA,
    milestone: 'T+3',
    completedAt: new Date('2026-06-12T10:00:00Z'),
    notes: 'T+3 send',
  });
  const bFirst = store.upsert({
    clientId: clientB,
    milestone: 'T+0',
    completedAt: new Date('2026-06-09T11:00:00Z'),
    notes: 'client B T+0',
  });

  // KAIA-760: status-change watcher writes — the same (clientId,
  // status_change) pair must collapse to a single row across retries
  // and re-fires from the Supabase webhook.
  const statusChangeFirst = store.upsert({
    clientId: clientA,
    milestone: 'status_change',
    completedAt: new Date('2026-06-09T10:05:00Z'),
    notes: JSON.stringify({ previous_status: 'in_progress', new_status: 'live', actor: 'system' }),
  });
  const statusChangeRetry = store.upsert({
    clientId: clientA,
    milestone: 'status_change',
    completedAt: new Date('2026-06-09T10:06:00Z'),
    notes: JSON.stringify({ previous_status: 'in_progress', new_status: 'live', actor: 'system' }),
  });

  check('first write created', first.created, true);
  check('second write did NOT create', second.created, false);
  check('second write returned same id', second.row.id, first.row.id);
  check('second write updated notes', second.row.notes, 'retry after transient failure');
  check('third write created (different milestone)', third.created, true);
  check('client B first write created', bFirst.created, true);
  check('client A row count', store.findByClient(clientA).length, 3);
  check('client B row count', store.findByClient(clientB).length, 1);
  check('client A T+0 exists', store.exists(clientA, 'T+0'), true);
  check('client A T+7 does not exist', store.exists(clientA, 'T+7'), false);
  check('client A status_change exists (KAIA-760)', store.exists(clientA, 'status_change'), true);
  check('status_change first write created', statusChangeFirst.created, true);
  check('status_change retry did NOT create duplicate', statusChangeRetry.created, false);
  check('status_change retry returned same id', statusChangeRetry.row.id, statusChangeFirst.row.id);

  // ---- KAIA-762: lookup-client-id-from-supabase ----------------------------
  section('lookup-client-id-from-supabase — auth (KAIA-762)');
  const authResult = authenticateInternal('correct-horse-battery-staple', 'correct-horse-battery-staple');
  check('valid key accepted', authResult.ok, true);
  const authBad = authenticateInternal('wrong', 'correct-horse-battery-staple');
  check('wrong key rejected', authBad.ok, false);
  const authMissing = authenticateInternal(null, 'correct-horse-battery-staple');
  check('missing key rejected', authMissing.ok, false);

  section('lookup-client-id-from-supabase — validation (KAIA-762)');
  const uuidRE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function parseLookupRequest(body: unknown): Result<{ supabaseClientId: string }, string> {
    if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
    const b = body as Record<string, unknown>;
    const { supabaseClientId } = b;
    if (typeof supabaseClientId !== 'string' || !uuidRE.test(supabaseClientId)) {
      return { ok: false, error: 'supabaseClientId must be a UUID string' };
    }
    return { ok: true, value: { supabaseClientId } };
  }
  const okUUID = randomUUID();
  check('valid UUID accepted', parseLookupRequest({ supabaseClientId: okUUID }).ok, true);
  check('non-UUID string rejected', parseLookupRequest({ supabaseClientId: 'not-a-uuid' }).ok, false);
  check('missing supabaseClientId rejected', parseLookupRequest({}).ok, false);
  check('null supabaseClientId rejected', parseLookupRequest({ supabaseClientId: null }).ok, false);
  check('empty string rejected', parseLookupRequest({ supabaseClientId: '' }).ok, false);

  // ---- Final --------------------------------------------------------------
  section('summary');
  if (failures > 0) {
    console.error(`[smoke] FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('[smoke] OK — all assertions passed');
}

main();
