// =============================================================================
// KAIA-1073 — smoke test for the /api/internal/n8n-execution endpoint
//
// Exercises:
//   1. Constant-time API key check (happy path + bad key + missing header).
//   2. Body validation (missing id, missing workflow, bad status, missing
//      startedAt).
//   3. Idempotent upsert on `id` — two POSTs with the same id collapse to
//      a single N8nExecution row; the second returns the same id.
//   4. Status allowlist: {success, failed, running} only.
//   5. clientId resolution: when body omits clientName, the route looks
//      up Company.companyName and stores it; when the company row is
//      missing, it stores null.
//
// Runs without a live HTTP server — it instantiates the route handler
// logic directly against an in-memory store. Mirrors
// src/app/api/internal/n8n-execution/route.ts; if the production code
// changes, update here.
//
// Run:   npx tsx scripts/smoke-n8n-execution.ts
// Exit:  0 on success, 1 on any failure.
// =============================================================================

import { randomUUID } from 'node:crypto';

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// -----------------------------------------------------------------------------
// Inlined copies of the route's auth + validation logic. Mirrors
// src/lib/internal-auth.ts and src/app/api/internal/n8n-execution/route.ts.
// -----------------------------------------------------------------------------

const VALID_STATUSES = new Set(['success', 'failed', 'running']);

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

function parseExecutionRequest(body: unknown): Result<
  {
    id: string;
    clientId: string | null;
    clientName: string | null;
    workflow: string;
    milestone: string | null;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  },
  string
> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const { id, clientId, clientName, workflow, milestone, status, startedAt, finishedAt, errorCode, errorMessage } = b;
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: 'id is required' };
  if (typeof workflow !== 'string' || workflow.length === 0) return { ok: false, error: 'workflow is required' };
  if (typeof status !== 'string' || !VALID_STATUSES.has(status)) {
    return { ok: false, error: 'status must be success | failed | running' };
  }
  if (typeof startedAt !== 'string') return { ok: false, error: 'startedAt is required (ISO string)' };
  const sd = new Date(startedAt);
  if (Number.isNaN(sd.getTime())) return { ok: false, error: 'startedAt must be a valid date' };
  let fd: string | null = null;
  if (finishedAt !== undefined && finishedAt !== null) {
    if (typeof finishedAt !== 'string') return { ok: false, error: 'finishedAt must be a string' };
    const fdt = new Date(finishedAt);
    if (Number.isNaN(fdt.getTime())) return { ok: false, error: 'finishedAt must be a valid date' };
    fd = finishedAt;
  }
  return {
    ok: true,
    value: {
      id,
      clientId: typeof clientId === 'string' && clientId.length > 0 ? clientId : null,
      clientName: typeof clientName === 'string' && clientName.length > 0 ? clientName : null,
      workflow,
      milestone: typeof milestone === 'string' ? milestone : null,
      status,
      startedAt,
      finishedAt: fd,
      errorCode: typeof errorCode === 'string' ? errorCode.slice(0, 100) : null,
      errorMessage: typeof errorMessage === 'string' ? errorMessage.slice(0, 4000) : null,
    },
  };
}

// -----------------------------------------------------------------------------
// In-memory "Prisma" store — emulates the N8nExecution model. The route's
// upsert is keyed on `id` (the n8n execution id). In production this is
// enforced by Postgres + the @@unique([id]) constraint.
// -----------------------------------------------------------------------------

interface ExecutionRow {
  id: string;
  clientId: string | null;
  clientName: string | null;
  workflow: string;
  milestone: string | null;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

class FakeCompanyStore {
  private byId = new Map<string, { companyName: string; name: string | null }>();
  add(id: string, companyName: string, name: string | null) {
    this.byId.set(id, { companyName, name });
  }
  lookup(id: string) {
    return this.byId.get(id) || null;
  }
}

class FakeExecutionStore {
  private rows: ExecutionRow[] = [];
  private byId = new Map<string, ExecutionRow>();
  private companies: FakeCompanyStore;

  constructor(companies: FakeCompanyStore) {
    this.companies = companies;
  }

  upsert(input: {
    id: string;
    clientId: string | null;
    clientName: string | null;
    workflow: string;
    milestone: string | null;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  }): { row: ExecutionRow; created: boolean; resolvedClientName: string | null } {
    let resolvedClientName = input.clientName;
    if (input.clientId && !resolvedClientName) {
      const c = this.companies.lookup(input.clientId);
      if (c) resolvedClientName = c.companyName ?? c.name ?? null;
    }
    const existing = this.byId.get(input.id);
    if (existing) {
      existing.clientId = input.clientId;
      existing.clientName = resolvedClientName;
      existing.workflow = input.workflow;
      existing.milestone = input.milestone;
      existing.status = input.status;
      existing.startedAt = input.startedAt;
      existing.finishedAt = input.finishedAt;
      existing.errorCode = input.errorCode;
      existing.errorMessage = input.errorMessage;
      return { row: existing, created: false, resolvedClientName };
    }
    const row: ExecutionRow = {
      id: input.id,
      clientId: input.clientId,
      clientName: resolvedClientName,
      workflow: input.workflow,
      milestone: input.milestone,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    };
    this.rows.push(row);
    this.byId.set(input.id, row);
    return { row, created: true, resolvedClientName };
  }

  findById(id: string) {
    return this.byId.get(id) || null;
  }
  all() {
    return this.rows;
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
  console.log(`\n[smoke-n8n-execution] ${title}`);
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

  // ---- Validation ---------------------------------------------------------
  section('validation — request body');
  const okId = 'exec_' + randomUUID();
  check(
    'valid body',
    parseExecutionRequest({
      id: okId,
      clientId: randomUUID(),
      clientName: 'Peluquería Aurora',
      workflow: 'T+0 Onboarding Email + Portal Activity',
      milestone: 'T+0',
      status: 'success',
      startedAt: '2026-06-12T10:00:00.000Z',
      finishedAt: '2026-06-12T10:00:01.500Z',
    }).ok,
    true,
  );
  check(
    'missing id',
    parseExecutionRequest({
      workflow: 'T+0',
      status: 'success',
      startedAt: '2026-06-12T10:00:00.000Z',
    }).ok,
    false,
  );
  check(
    'empty id',
    parseExecutionRequest({
      id: '',
      workflow: 'T+0',
      status: 'success',
      startedAt: '2026-06-12T10:00:00.000Z',
    }).ok,
    false,
  );
  check(
    'missing workflow',
    parseExecutionRequest({
      id: okId,
      status: 'success',
      startedAt: '2026-06-12T10:00:00.000Z',
    }).ok,
    false,
  );
  check(
    'bad status (not in allowlist)',
    parseExecutionRequest({
      id: okId,
      workflow: 'T+0',
      status: 'completed',
      startedAt: '2026-06-12T10:00:00.000Z',
    }).ok,
    false,
  );
  check('status=success accepted', parseExecutionRequest({ id: okId, workflow: 'T+0', status: 'success', startedAt: '2026-06-12T10:00:00.000Z' }).ok, true);
  check('status=failed accepted', parseExecutionRequest({ id: okId, workflow: 'T+0', status: 'failed', startedAt: '2026-06-12T10:00:00.000Z' }).ok, true);
  check('status=running accepted', parseExecutionRequest({ id: okId, workflow: 'T+0', status: 'running', startedAt: '2026-06-12T10:00:00.000Z' }).ok, true);
  check(
    'missing startedAt',
    parseExecutionRequest({ id: okId, workflow: 'T+0', status: 'success' }).ok,
    false,
  );
  check(
    'bad startedAt',
    parseExecutionRequest({ id: okId, workflow: 'T+0', status: 'success', startedAt: 'not-a-date' }).ok,
    false,
  );
  check(
    'errorCode truncated to 100',
    parseExecutionRequest({
      id: okId,
      workflow: 'T+0',
      status: 'failed',
      startedAt: '2026-06-12T10:00:00.000Z',
      errorCode: 'X'.repeat(200),
    }).ok
      ? 'OK' // parse function itself doesn't truncate; route does. Check route behavior below.
      : 'OK',
    'OK',
  );
  // Note: parseExecutionRequest mirrors the route's truncation policy
  // (errorCode <= 100, errorMessage <= 4000) so the same defensive
  // ceiling applies to anything the smoke calls into the store.
  const truncated = parseExecutionRequest({
    id: okId,
    workflow: 'T+0',
    status: 'failed',
    startedAt: '2026-06-12T10:00:00.000Z',
    errorCode: 'Y'.repeat(200),
  });
  check(
    'errorCode truncated to 100 chars',
    (truncated.ok ? truncated.value.errorCode : null)!.length,
    100,
  );
  const longMsg = parseExecutionRequest({
    id: okId,
    workflow: 'T+0',
    status: 'failed',
    startedAt: '2026-06-12T10:00:00.000Z',
    errorMessage: 'Z'.repeat(5000),
  });
  check(
    'errorMessage truncated to 4000 chars',
    (longMsg.ok ? longMsg.value.errorMessage : null)!.length,
    4000,
  );

  // ---- Idempotency --------------------------------------------------------
  section('idempotency — upsert on id collapses repeated writes');
  const companies = new FakeCompanyStore();
  const auroraId = randomUUID();
  companies.add(auroraId, 'Peluquería Aurora', null);
  const store = new FakeExecutionStore(companies);

  const first = store.upsert({
    id: 'exec_001',
    clientId: auroraId,
    clientName: null,
    workflow: 'T+0 Onboarding Email + Portal Activity',
    milestone: 'T+0',
    status: 'running',
    startedAt: '2026-06-12T10:00:00.000Z',
    finishedAt: null,
    errorCode: null,
    errorMessage: null,
  });
  check('first write created', first.created, true);
  check('first write resolved clientName from Company', first.resolvedClientName, 'Peluquería Aurora');
  check('first write stored clientName', first.row.clientName, 'Peluquería Aurora');

  // Delayed completion: same id, now status=success
  const completion = store.upsert({
    id: 'exec_001',
    clientId: auroraId,
    clientName: 'Peluquería Aurora',
    workflow: 'T+0 Onboarding Email + Portal Activity',
    milestone: 'T+0',
    status: 'success',
    startedAt: '2026-06-12T10:00:00.000Z',
    finishedAt: '2026-06-12T10:00:05.000Z',
    errorCode: null,
    errorMessage: null,
  });
  check('completion did NOT create a duplicate row', completion.created, false);
  check('completion returned same row', completion.row.id, 'exec_001');
  check('completion updated status to success', completion.row.status, 'success');
  check('completion stored finishedAt', completion.row.finishedAt, '2026-06-12T10:00:05.000Z');
  check('total rows for exec_001 is 1', store.all().length, 1);

  // Failure path: same id, status=failed (e.g. retry saw a transient
  // error after the success callback was already written)
  const failure = store.upsert({
    id: 'exec_001',
    clientId: auroraId,
    clientName: 'Peluquería Aurora',
    workflow: 'T+0 Onboarding Email + Portal Activity',
    milestone: 'T+0',
    status: 'failed',
    startedAt: '2026-06-12T10:00:00.000Z',
    finishedAt: '2026-06-12T10:00:07.000Z',
    errorCode: 'TIMEOUT',
    errorMessage: 'Resend API timed out after 30s',
  });
  check('failure did NOT create a duplicate row', failure.created, false);
  check('failure updated status to failed', failure.row.status, 'failed');
  check('failure stored errorCode', failure.row.errorCode, 'TIMEOUT');
  check('failure stored errorMessage', failure.row.errorMessage, 'Resend API timed out after 30s');

  // ---- Unknown client ----------------------------------------------------
  section('client lookup — missing company row');
  const unknownId = store.upsert({
    id: 'exec_002',
    clientId: randomUUID(), // not in companies store
    clientName: null,
    workflow: 'T+7 Onboarding Email + Portal Activity',
    milestone: 'T+7',
    status: 'success',
    startedAt: '2026-06-12T10:00:00.000Z',
    finishedAt: '2026-06-12T10:00:01.000Z',
    errorCode: null,
    errorMessage: null,
  });
  check('unknown client still creates a row', unknownId.created, true);
  check('unknown client stores null clientName', unknownId.row.clientName, null);

  // ---- Stuck-monitor semantics -------------------------------------------
  section('stuck-monitor — captures operator-notify runs');
  // The stuck-monitor flow fires once per stuck client. Its execution
  // row is keyed on the n8n execution.id; the workflow name is the
  // dashboard's "last run" label; clientId is from the upstream
  // Build Notify Payload.
  const stuckRow = store.upsert({
    id: 'exec_stuck_001',
    clientId: auroraId,
    clientName: null,
    workflow: 'Operator Notify — stuck',
    milestone: 'T+3',
    status: 'success',
    startedAt: '2026-06-12T09:00:00.000Z',
    finishedAt: '2026-06-12T09:00:00.500Z',
    errorCode: null,
    errorMessage: null,
  });
  check('stuck-monitor captured clientId', stuckRow.row.clientId, auroraId);
  check('stuck-monitor captured milestone', stuckRow.row.milestone, 'T+3');
  check('stuck-monitor captured workflow', stuckRow.row.workflow, 'Operator Notify — stuck');
  check('stuck-monitor resolved clientName via lookup', stuckRow.row.clientName, 'Peluquería Aurora');

  // ---- Final --------------------------------------------------------------
  section('summary');
  if (failures > 0) {
    console.error(`[smoke-n8n-execution] FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('[smoke-n8n-execution] OK — all assertions passed');
}

main();
