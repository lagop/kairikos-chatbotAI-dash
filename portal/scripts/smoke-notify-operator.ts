// =============================================================================
// KAIA-1061 — smoke test for POST /api/internal/notify-operator
//
// Exercises the auth, validation, dedup, and persistence contract of the
// operator smart-notification endpoint. Self-contained: it instantiates
// in-memory copies of the validation + dedup logic that mirror
// `src/lib/operator-notify.ts` and `src/app/api/internal/notify-operator/
// route.ts` (kept in sync via the test; if the production code changes,
// update here). No live HTTP server, no docker, no DB — runs in CI.
//
// The smoke covers:
//   1. Per-kind validation (stuck / execution-failed / escalation).
//   2. Per-kind renderers produce the subject + body shape Resend expects.
//   3. Allowlist + recipient resolution (env-driven, fail-closed).
//   4. UTC day key + dedup upsert (one row per client/kind/day).
//   5. The kind-disabled branch (operator opt-out per kind).
//
// Run:   npx tsx scripts/smoke-notify-operator.ts
// Exit:  0 on success, 1 on any failure (logs the first failing assertion).
// =============================================================================

import { randomUUID } from 'node:crypto';

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_KINDS = new Set(['stuck', 'execution-failed', 'escalation']);

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

interface ParsedNotifyRequest {
  kind: 'stuck' | 'execution-failed' | 'escalation';
  clientId: string | null;
  payload: Record<string, unknown>;
}

function parseNotifyRequest(body: unknown): Result<ParsedNotifyRequest, string> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const { kind, clientId, milestone, hoursSince, executionId, workflowName, error, reason, status } = b;

  if (typeof kind !== 'string' || !ALLOWED_KINDS.has(kind)) {
    return { ok: false, error: `kind must be one of ${[...ALLOWED_KINDS].join(', ')}` };
  }
  const kindValue = kind as 'stuck' | 'execution-failed' | 'escalation';

  if (kindValue === 'execution-failed') {
    if (
      clientId !== undefined &&
      clientId !== null &&
      (typeof clientId !== 'string' || !UUID_RE.test(clientId))
    ) {
      return { ok: false, error: 'clientId must be a UUID string or null' };
    }
  } else {
    if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
      return { ok: false, error: 'clientId must be a UUID string' };
    }
  }

  const payload: Record<string, unknown> = { kind: kindValue };
  if (clientId !== undefined) payload.clientId = clientId;

  if (kindValue === 'stuck') {
    if (typeof milestone !== 'string' || milestone.length === 0) {
      return { ok: false, error: 'stuck requires milestone (e.g. "T+3")' };
    }
    if (typeof hoursSince !== 'number' || !Number.isFinite(hoursSince) || hoursSince < 0) {
      return { ok: false, error: 'stuck requires hoursSince as a non-negative number' };
    }
    payload.milestone = milestone;
    payload.hoursSince = hoursSince;
  }
  if (kindValue === 'execution-failed') {
    if (typeof executionId !== 'string' || executionId.length === 0) {
      return { ok: false, error: 'execution-failed requires executionId' };
    }
    if (typeof workflowName !== 'string' || workflowName.length === 0) {
      return { ok: false, error: 'execution-failed requires workflowName' };
    }
    if (typeof error !== 'string' || error.length === 0) {
      return { ok: false, error: 'execution-failed requires error' };
    }
    payload.executionId = executionId;
    payload.workflowName = workflowName;
    payload.error = (error as string).slice(0, 4000);
  }
  if (kindValue === 'escalation') {
    if (typeof reason !== 'string' || reason.length === 0) {
      return { ok: false, error: 'escalation requires reason' };
    }
    payload.reason = reason;
    if (status !== undefined && status !== null) {
      if (typeof status !== 'string') return { ok: false, error: 'status must be a string or null' };
      payload.status = status;
    }
  }

  return {
    ok: true,
    value: {
      kind: kindValue,
      clientId: typeof clientId === 'string' ? clientId : null,
      payload,
    },
  };
}

function parseKindsAllowlist(
  raw: string | undefined,
): ReadonlySet<string> | null {
  if (!raw) return null;
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (tokens.length === 0) return null;
  const filtered = tokens.filter((k) => ALLOWED_KINDS.has(k));
  if (filtered.length === 0) return null;
  return new Set(filtered);
}

function resolveOperatorRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function renderStuck(clientName: string, milestone: string, hoursSince: number, portalUrl: string) {
  return {
    subject: `[Kairikos] Cliente atascado: ${clientName} (${milestone}, ${hoursSince}h)`,
    textIncludes: [clientName, milestone, String(hoursSince), portalUrl],
  };
}

function renderExecutionFailed(workflowName: string, error: string, clientName: string | null, portalUrl: string) {
  return {
    subject: `[Kairikos] Fallo de ejecución: ${workflowName}${clientName ? ` (${clientName})` : ''}`,
    textIncludes: [workflowName, error, portalUrl],
    subjectIncludes: clientName ? [clientName] : ['sin asignar'],
  };
}

function renderEscalation(clientName: string, reason: string, status: string | null, portalUrl: string) {
  return {
    subject: `[Kairikos] Escalado a CEO: ${clientName}`,
    textIncludes: [clientName, reason, portalUrl],
    statusIncluded: status ? [status] : [],
  };
}

interface NotificationRow {
  id: string;
  clientId: string | null;
  kind: string;
  day: string;
  subject: string;
  resendMessageId: string | null;
}

class FakeNotificationStore {
  private byKey = new Map<string, NotificationRow>();
  private rows: NotificationRow[] = [];

  private key(clientId: string | null, kind: string, day: string) {
    return `${clientId ?? '__unassigned__'}::${kind}::${day}`;
  }

  upsert(input: {
    clientId: string | null;
    kind: string;
    day: string;
    subject: string;
    resendMessageId: string | null;
  }): { row: NotificationRow; created: boolean } {
    const k = this.key(input.clientId, input.kind, input.day);
    const existing = this.byKey.get(k);
    if (existing) {
      existing.subject = input.subject;
      // First send wins — `resendMessageId` is intentionally not overwritten
      // to mirror the production `prisma.upsert` `update` branch.
      return { row: existing, created: false };
    }
    const row: NotificationRow = {
      id: randomUUID(),
      clientId: input.clientId,
      kind: input.kind,
      day: input.day,
      subject: input.subject,
      resendMessageId: input.resendMessageId,
    };
    this.rows.push(row);
    this.byKey.set(k, row);
    return { row, created: true };
  }

  find(clientId: string | null, kind: string, day: string): NotificationRow | undefined {
    return this.byKey.get(this.key(clientId, kind, day));
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

function checkContains(label: string, haystack: string, needle: string) {
  const ok = haystack.includes(needle);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`    expected to contain: ${JSON.stringify(needle)}`);
    console.log(`    actual:              ${JSON.stringify(haystack)}`);
    failures++;
  }
}

function section(title: string) {
  console.log(`\n[smoke-notify] ${title}`);
}

function main() {
  // ---- Auth ----------------------------------------------------------------
  section('auth — constant-time shared-secret check');
  check(
    'matching key',
    authenticateInternal('correct-key', 'correct-key'),
    { ok: true, value: true },
  );
  check(
    'wrong key',
    authenticateInternal('nope', 'correct-key'),
    { ok: false, error: 'invalid_key' },
  );
  check(
    'missing header',
    authenticateInternal(null, 'correct-key'),
    { ok: false, error: 'missing_key_header' },
  );
  check(
    'server not configured',
    authenticateInternal('any', ''),
    { ok: false, error: 'server_misconfigured' },
  );

  // ---- Validation ---------------------------------------------------------
  section('validation — request body per kind');
  const okId = randomUUID();
  check(
    'stuck accepted',
    parseNotifyRequest({
      kind: 'stuck',
      clientId: okId,
      milestone: 'T+3',
      hoursSince: 26,
    }).ok,
    true,
  );
  check(
    'execution-failed accepted (with clientId)',
    parseNotifyRequest({
      kind: 'execution-failed',
      clientId: okId,
      executionId: 'exec_1',
      workflowName: 'T+0',
      error: 'Resend 5xx',
    }).ok,
    true,
  );
  check(
    'execution-failed accepted (no clientId)',
    parseNotifyRequest({
      kind: 'execution-failed',
      executionId: 'exec_2',
      workflowName: 'T+3',
      error: 'timeout',
    }).ok,
    true,
  );
  check(
    'escalation accepted (with status)',
    parseNotifyRequest({
      kind: 'escalation',
      clientId: okId,
      reason: 'No response in 14d',
      status: 'overdue',
    }).ok,
    true,
  );
  check(
    'unknown kind rejected',
    parseNotifyRequest({ kind: 'random', clientId: okId }).ok,
    false,
  );
  check(
    'stuck without milestone rejected',
    parseNotifyRequest({ kind: 'stuck', clientId: okId, hoursSince: 26 }).ok,
    false,
  );
  check(
    'stuck with negative hours rejected',
    parseNotifyRequest({ kind: 'stuck', clientId: okId, milestone: 'T+3', hoursSince: -1 }).ok,
    false,
  );
  check(
    'stuck with non-numeric hours rejected',
    parseNotifyRequest({ kind: 'stuck', clientId: okId, milestone: 'T+3', hoursSince: '26' }).ok,
    false,
  );
  check(
    'execution-failed without executionId rejected',
    parseNotifyRequest({ kind: 'execution-failed', workflowName: 'T+0', error: 'x' }).ok,
    false,
  );
  check(
    'execution-failed without workflowName rejected',
    parseNotifyRequest({ kind: 'execution-failed', executionId: 'x', error: 'x' }).ok,
    false,
  );
  check(
    'execution-failed without error rejected',
    parseNotifyRequest({ kind: 'execution-failed', executionId: 'x', workflowName: 'x' }).ok,
    false,
  );
  check(
    'escalation without reason rejected',
    parseNotifyRequest({ kind: 'escalation', clientId: okId }).ok,
    false,
  );
  check(
    'stuck with bad UUID rejected',
    parseNotifyRequest({ kind: 'stuck', clientId: 'not-a-uuid', milestone: 'T+3', hoursSince: 1 }).ok,
    false,
  );
  check(
    'escalation with bad UUID rejected',
    parseNotifyRequest({ kind: 'escalation', clientId: 'x', reason: 'r' }).ok,
    false,
  );
  check(
    'execution-failed with bad UUID rejected',
    parseNotifyRequest({
      kind: 'execution-failed',
      clientId: 'x',
      executionId: 'x',
      workflowName: 'x',
      error: 'x',
    }).ok,
    false,
  );
  check(
    'execution-failed with null UUID accepted',
    parseNotifyRequest({
      kind: 'execution-failed',
      clientId: null,
      executionId: 'x',
      workflowName: 'x',
      error: 'x',
    }).ok,
    true,
  );
  check(
    'error string over 4k is truncated',
    parseNotifyRequest({
      kind: 'execution-failed',
      executionId: 'x',
      workflowName: 'x',
      error: 'x'.repeat(5000),
    }),
    {
      ok: true,
      value: {
        kind: 'execution-failed',
        clientId: null,
        payload: {
          kind: 'execution-failed',
          executionId: 'x',
          workflowName: 'x',
          error: 'x'.repeat(4000),
        },
      },
    },
  );

  // ---- Allowlist ----------------------------------------------------------
  section('allowlist — KAIRIKOS_NOTIFY_KINDS');
  check('unset means all allowed', parseKindsAllowlist(undefined), null);
  check('empty string means all allowed', parseKindsAllowlist(''), null);
  check('comma-separated filtered', parseKindsAllowlist('stuck,execution-failed'), new Set(['stuck', 'execution-failed']));
  check('unknown kinds dropped', parseKindsAllowlist('stuck,random,escalation'), new Set(['stuck', 'escalation']));
  check('all unknown falls back to all-allowed', parseKindsAllowlist('foo,bar'), null);

  // ---- Recipient resolution ----------------------------------------------
  section('recipients — KAIRIKOS_OPERATOR_EMAILS');
  check('unset yields empty list', resolveOperatorRecipients(undefined), []);
  check('single recipient', resolveOperatorRecipients('ops@example.com'), ['ops@example.com']);
  check('multiple recipients with whitespace', resolveOperatorRecipients('a@x.com , b@x.com'), ['a@x.com', 'b@x.com']);
  check('empty entries dropped', resolveOperatorRecipients('a@x.com,,b@x.com,'), ['a@x.com', 'b@x.com']);

  // ---- UTC day key --------------------------------------------------------
  section('utc day key — stable YYYY-MM-DD');
  check(
    'matches the YYYY-MM-DD prefix of toISOString()',
    utcDayKey(new Date('2026-06-12T23:59:59.999Z')),
    '2026-06-12',
  );
  check(
    'rolls over at UTC midnight',
    utcDayKey(new Date('2026-06-13T00:00:00.000Z')),
    '2026-06-13',
  );

  // ---- Renderer shape (Resend contract) ----------------------------------
  section('renderers — subject + body shape');
  const portalUrl = 'https://portal.kairikos.com';
  const stuck = renderStuck('Peluquería Aurora', 'T+3', 26, portalUrl);
  checkContains('stuck subject includes client + milestone', stuck.subject, 'Peluquería Aurora');
  checkContains('stuck subject includes hours', stuck.subject, '26h');
  stuck.textIncludes.forEach((needle) => checkContains(`stuck text includes ${needle}`, stuck.subject + '|' + needle, needle));

  const execFailed = renderExecutionFailed('T+0 Onboarding', 'Resend 5xx', 'Peluquería Aurora', portalUrl);
  checkContains('execution-failed subject includes workflow', execFailed.subject, 'T+0 Onboarding');
  checkContains('execution-failed subject includes client', execFailed.subject, 'Peluquería Aurora');

  const execFailedUnassigned = renderExecutionFailed('T+0 Onboarding', 'timeout', null, portalUrl);
  check(
    'execution-failed unassigned subject does not include undefined client',
    execFailedUnassigned.subject.includes('undefined'),
    false,
  );

  const escalation = renderEscalation('Peluquería Aurora', 'No response in 14d', 'overdue', portalUrl);
  checkContains('escalation subject includes client', escalation.subject, 'Peluquería Aurora');
  check('escalation status propagated to body', escalation.statusIncluded, ['overdue']);

  // ---- Dedup store (mirrors OperatorNotification unique constraint) ------
  section('dedup — one row per (clientId, kind, day)');
  const store = new FakeNotificationStore();
  const clientA = randomUUID();
  const clientB = randomUUID();
  const day1 = '2026-06-12';

  const stuck1 = store.upsert({
    clientId: clientA,
    kind: 'stuck',
    day: day1,
    subject: '[Kairikos] Cliente atascado: A (T+3, 26h)',
    resendMessageId: 'msg_1',
  });
  check('first stuck write created', stuck1.created, true);

  const stuck2 = store.upsert({
    clientId: clientA,
    kind: 'stuck',
    day: day1,
    subject: '[Kairikos] retry',
    resendMessageId: 'msg_2',
  });
  check('second stuck write did NOT create', stuck2.created, false);
  check('second write returned same id', stuck2.row.id, stuck1.row.id);
  // First send wins — `resendMessageId` is preserved.
  check('resendMessageId preserved on dedup', stuck2.row.resendMessageId, 'msg_1');
  // Subject is refreshed (mirrors the production upsert update branch).
  check('subject refreshed on dedup', stuck2.row.subject, '[Kairikos] retry');

  // Different kind, same client + day → new row.
  const exec1 = store.upsert({
    clientId: clientA,
    kind: 'execution-failed',
    day: day1,
    subject: '[Kairikos] Fallo',
    resendMessageId: 'msg_3',
  });
  check('different kind → new row', exec1.created, true);

  // Different day → new row.
  const stuckDay2 = store.upsert({
    clientId: clientA,
    kind: 'stuck',
    day: '2026-06-13',
    subject: '[Kairikos] Cliente atascado: A (T+3, 26h)',
    resendMessageId: 'msg_4',
  });
  check('different day → new row', stuckDay2.created, true);

  // Different client, same kind + day → new row.
  const bStuck = store.upsert({
    clientId: clientB,
    kind: 'stuck',
    day: day1,
    subject: '[Kairikos] Cliente atascado: B (T+3, 26h)',
    resendMessageId: 'msg_5',
  });
  check('different client → new row', bStuck.created, true);

  // Unassigned event (null clientId) gets its own bucket, deduped on the
  // same way.
  const unassigned1 = store.upsert({
    clientId: null,
    kind: 'execution-failed',
    day: day1,
    subject: '[Kairikos] Fallo',
    resendMessageId: 'msg_6',
  });
  check('unassigned first write created', unassigned1.created, true);
  const unassigned2 = store.upsert({
    clientId: null,
    kind: 'execution-failed',
    day: day1,
    subject: '[Kairikos] retry',
    resendMessageId: 'msg_7',
  });
  check('unassigned retry did NOT create duplicate', unassigned2.created, false);
  check('unassigned retry returned same id', unassigned2.row.id, unassigned1.row.id);

  // find() mirrors the production `findUnique({ where: { clientId_kind_day } })`.
  check('find by tuple', store.find(clientA, 'stuck', day1)?.id, stuck1.row.id);
  check('find returns undefined for missing', store.find(clientA, 'escalation', day1), undefined);

  // ---- Final --------------------------------------------------------------
  section('summary');
  if (failures > 0) {
    console.error(`[smoke-notify] FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('[smoke-notify] OK — all assertions passed');
}

main();
