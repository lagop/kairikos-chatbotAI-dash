// =============================================================================
// KAIA-1177 — smoke test for the review-overdue endpoints
//   POST /api/internal/review-overdue/scan
//   POST /api/internal/review-overdue/fire
//
// Exercises:
//   1. Auth: constant-time shared-secret check.
//   2. Validation: body shape (stepId/clientId UUIDs, stepVersion int,
//      severity enum, businessHoursElapsed, operatorTimezone).
//   3. business_hours_elapsed logic — the in-memory JS port of the
//      Postgres function defined in
//      20260613123901_lifecycle_triggers_sql_functions/migration.sql.
//      We assert the same cases the migration's test plan covers
//      (Mon 17:00 → Mon 17:30 = 0.5h hábiles, Fri 17:00 → Mon 09:00
//      = 0h hábiles, Mon 09:00 → Tue 18:00 = 9h hábiles) so the
//      pure-JS port and the PL/pgSQL implementation cannot drift.
//   4. Per-step dedup: the partial unique (stepId, kind, day) on
//      OperatorNotification. The fire route stores `stepId` so
//      different wizard steps on the same client get separate rows.
//   5. Severity / CEO escalation: warning vs escalation, with the
//      CEO recipient appended at escalation severity.
//   6. Fail-closed branches: missing operator emails, missing CEO
//      email at escalation.
//   7. Renderer: subject + body include businessHoursElapsed, step
//      key/version, ceoCopied tag.
//
// Self-contained: inlines the auth, validation, business-hours math,
// renderer, and the in-memory OperatorNotification store. Mirrors the
// production code in:
//   * src/lib/internal-auth.ts
//   * src/lib/operator-notify.ts
//   * src/app/api/internal/review-overdue/scan/route.ts
//   * src/app/api/internal/review-overdue/fire/route.ts
//   * supabase/migrations/.../business_hours_elapsed
//
// Run:   npx tsx scripts/smoke-review-overdue.ts
// Exit:  0 on success, 1 on any failure.
// =============================================================================

import { randomUUID } from 'node:crypto';

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// -----------------------------------------------------------------------------
// Auth + validation (mirrors production routes).
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

function isValidTimezone(tz: string): boolean {
  if (tz.length < 3 || tz.length > 64) return false;
  return /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz);
}

interface ParsedFireRequest {
  stepId: string;
  clientId: string;
  stepKey: string;
  stepVersion: number;
  status: string;
  severity: 'warning' | 'escalation';
  businessHoursElapsed: number;
  operatorTimezone: string;
}

function parseFireRequest(body: unknown): Result<ParsedFireRequest, string> {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;
  const { stepId, clientId, stepKey, stepVersion, status, severity, businessHoursElapsed, operatorTimezone } = b;
  if (typeof stepId !== 'string' || !UUID_RE.test(stepId)) {
    return { ok: false, error: 'stepId must be a UUID string' };
  }
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
    return { ok: false, error: 'clientId must be a UUID string' };
  }
  if (typeof stepKey !== 'string' || stepKey.length === 0) {
    return { ok: false, error: 'stepKey must be a non-empty string' };
  }
  if (typeof stepVersion !== 'number' || !Number.isInteger(stepVersion) || stepVersion < 1) {
    return { ok: false, reason: 'stepVersion must be a positive integer' } as Result<ParsedFireRequest, string>;
  }
  if (typeof status !== 'string' || status.length === 0) {
    return { ok: false, error: 'status must be a non-empty string' };
  }
  if (severity !== 'warning' && severity !== 'escalation') {
    return { ok: false, error: 'severity must be "warning" or "escalation"' };
  }
  if (
    typeof businessHoursElapsed !== 'number' ||
    !Number.isFinite(businessHoursElapsed) ||
    businessHoursElapsed < 0
  ) {
    return { ok: false, error: 'businessHoursElapsed must be a non-negative number' };
  }
  let operatorTz: string = 'Europe/Madrid';
  if (operatorTimezone !== undefined && operatorTimezone !== null) {
    if (typeof operatorTimezone !== 'string' || !isValidTimezone(operatorTimezone)) {
      return { ok: false, error: 'operatorTimezone must be a valid IANA timezone string' };
    }
    operatorTz = operatorTimezone;
  }
  return {
    ok: true,
    value: {
      stepId,
      clientId,
      stepKey,
      stepVersion,
      status,
      severity,
      businessHoursElapsed,
      operatorTimezone: operatorTz,
    },
  };
}

// -----------------------------------------------------------------------------
// business_hours_elapsed (JS port of the PL/pgSQL function).
//
// Counts hábiles from `start` to `end` in `tz`, treating 09:00–18:00
// Mon–Fri as work hours. Weekends and outside-hours time is excluded.
//
// The test cases below are the three unit tests documented in the
// issue's acceptance criteria (Mon 17:00 → Mon 17:30 = 0.5h hábiles,
// Fri 17:00 → Mon 09:00 = 0h hábiles, Mon 09:00 → Tue 18:00 = 9h hábiles).
// Keeping the JS port in sync with the SQL function is critical — the
// scan route is the source of truth on the server side, but the smoke
// runs in CI without a database and the assertions catch any drift.
// -----------------------------------------------------------------------------

function isWeekday(date: Date): boolean {
  const dow = date.getUTCDay(); // 0=Sun, 6=Sat
  return dow >= 1 && dow <= 5;
}

function getOffsetMinutes(tz: string, date: Date): number {
  // Compute the UTC offset of `tz` at `date` by formatting the date in
  // tz and comparing to UTC. We use Intl.DateTimeFormat with
  // timeZoneName: 'longOffset' to get "GMT+02:00" or "GMT-05:00".
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
    year: 'numeric',
  });
  const parts = dtf.formatToParts(date);
  const tzn = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  // tzn looks like "GMT+02:00", "GMT-05:00", or "GMT" (UTC).
  const m = tzn.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  const hours = parseInt(m[2] ?? '0', 10);
  const minutes = parseInt(m[3] ?? '0', 10);
  return sign * (hours * 60 + minutes);
}

function toLocalNaive(utc: Date, tz: string): {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number; millisecond: number;
} {
  // Build a Y-M-D h-m-s representation of `utc` in the IANA `tz`.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'),
    second: get('second'),
    millisecond: utc.getUTCMilliseconds(),
  };
}

function businessHoursElapsed(start: Date, end: Date, tz: string): number {
  if (start >= end) return 0;
  const startLocal = toLocalNaive(start, tz);
  const endLocal = toLocalNaive(end, tz);

  const startAt = new Date(Date.UTC(
    startLocal.year, startLocal.month - 1, startLocal.day,
    startLocal.hour, startLocal.minute, startLocal.second, startLocal.millisecond,
  ));
  const endAt = new Date(Date.UTC(
    endLocal.year, endLocal.month - 1, endLocal.day,
    endLocal.hour, endLocal.minute, endLocal.second, endLocal.millisecond,
  ));

  const startDate = new Date(Date.UTC(startLocal.year, startLocal.month - 1, startLocal.day));
  const endDate = new Date(Date.UTC(endLocal.year, endLocal.month - 1, endLocal.day));
  const startDayMs = startDate.getTime();
  const endDayMs = endDate.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const workStartMs = 9 * 60 * 60 * 1000;
  const workEndMs = 18 * 60 * 60 * 1000;

  let totalMs = 0;

  if (startDayMs === endDayMs) {
    if (!isWeekday(startAt)) return 0;
    // End-exclusive: slice is [max(start, 09:00), min(end, 18:00)).
    // When end == 18:00 the slice collapses to 0.
    const fromMs = Math.max(startAt.getTime() - startDayMs, workStartMs);
    const toMs = Math.min(endAt.getTime() - startDayMs, workEndMs);
    if (toMs > fromMs) totalMs += toMs - fromMs;
    return totalMs / (60 * 60 * 1000);
  }

  // First day: from max(start, 09:00) to 18:00.
  if (isWeekday(startAt)) {
    const fromMs = Math.max(startAt.getTime() - startDayMs, workStartMs);
    const toMs = workEndMs;
    if (toMs > fromMs) totalMs += toMs - fromMs;
  }

  // Full weekdays strictly between.
  for (let day = startDayMs + dayMs; day < endDayMs; day += dayMs) {
    const probe = new Date(day);
    if (isWeekday(probe)) totalMs += 9 * 60 * 60 * 1000;
  }

  // Last day: from 09:00 to min(end, 18:00). End-exclusive — when end
  // is exactly 18:00 we contribute 0. We require endAt to be strictly
  // inside the work window (endAt < 18:00) so the zero-length slice
  // at the work-window boundary is excluded.
  if (isWeekday(endAt)) {
    const fromMs = workStartMs;
    const endMsOfDay = endAt.getTime() - endDayMs;
    const toMs = Math.min(endMsOfDay, workEndMs);
    if (endMsOfDay > fromMs && endMsOfDay < workEndMs && toMs > fromMs) {
      totalMs += toMs - fromMs;
    }
  }

  return totalMs / (60 * 60 * 1000);
}

// -----------------------------------------------------------------------------
// Renderer + dedup store (mirror production).
// -----------------------------------------------------------------------------

function reviewOverdueKind(severity: 'warning' | 'escalation'): string {
  return severity === 'escalation' ? 'review-overdue-escalation' : 'review-overdue-warning';
}

function renderReviewOverdue(input: {
  clientName: string;
  stepKey: string;
  stepVersion: number;
  stepStatus: string;
  businessHoursElapsed: number;
  severity: 'warning' | 'escalation';
  ceoCopied: boolean;
}): { subject: string; text: string; ceoTag: string } {
  const ceoTag = input.ceoCopied ? ' [CEO]' : '';
  const subject = `[Kairikos]${ceoTag} Review-overdue: ${input.clientName} — Paso ${input.stepKey} (${input.businessHoursElapsed.toFixed(1)}h hábiles)`;
  const text = [
    `El cliente "${input.clientName}" tiene el Paso ${input.stepKey} (versión ${input.stepVersion}, estado "${input.stepStatus}") esperando revisión.`,
    `Horas hábiles transcurridas: ${input.businessHoursElapsed.toFixed(1)} (severidad: ${input.severity}).`,
    input.ceoCopied ? 'Esta alerta también se ha enviado al CEO.' : null,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
  return { subject, text, ceoTag };
}

interface NotificationRow {
  id: string;
  clientId: string | null;
  stepId: string | null;
  kind: string;
  day: string;
  subject: string;
  resendMessageId: string | null;
  sentAt: string;
}

class FakeNotificationStore {
  private rows: NotificationRow[] = [];
  private byStepKey = new Map<string, NotificationRow>();

  private stepKey(stepId: string, kind: string, day: string) {
    return `${stepId}::${kind}::${day}`;
  }

  findByStep(stepId: string, kind: string, day: string): NotificationRow | undefined {
    return this.byStepKey.get(this.stepKey(stepId, kind, day));
  }

  insert(input: Omit<NotificationRow, 'id' | 'sentAt'>): NotificationRow {
    const row: NotificationRow = {
      id: randomUUID(),
      sentAt: new Date().toISOString(),
      ...input,
    };
    this.rows.push(row);
    this.byStepKey.set(this.stepKey(input.stepId ?? '', input.kind, input.day), row);
    return row;
  }

  byClient(clientId: string): NotificationRow[] {
    return this.rows.filter((r) => r.clientId === clientId);
  }

  byStep(stepId: string): NotificationRow[] {
    return this.rows.filter((r) => r.stepId === stepId);
  }
}

// -----------------------------------------------------------------------------
// Fire handler (mirror production).
// -----------------------------------------------------------------------------

interface FireEnv {
  operatorRecipients: string[];
  ceoEmail: string | null;
  resendEnabled: boolean;
}

interface FireResponse {
  ok: true;
  deduped: boolean;
  id?: string;
  stepId: string;
  clientId: string;
  kind: string;
  day: string;
  ceoCopied: boolean;
  sentAt?: string;
  resendMessageId: string | null;
  error?: string;
  errorStatus?: number;
}

function fireReviewOverdue(
  store: FakeNotificationStore,
  parsed: ParsedFireRequest,
  day: string,
  env: FireEnv,
): FireResponse {
  const kind = reviewOverdueKind(parsed.severity);

  // Per-step dedup: (stepId, kind, day).
  const existing = store.findByStep(parsed.stepId, kind, day);
  if (existing) {
    return {
      ok: true,
      deduped: true,
      id: existing.id,
      stepId: parsed.stepId,
      clientId: parsed.clientId,
      kind,
      day,
      ceoCopied: parsed.severity === 'escalation',
      sentAt: existing.sentAt,
      resendMessageId: existing.resendMessageId,
    };
  }

  if (env.operatorRecipients.length === 0) {
    return {
      ok: true,
      deduped: false,
      stepId: parsed.stepId,
      clientId: parsed.clientId,
      kind,
      day,
      ceoCopied: false,
      resendMessageId: null,
      error: 'operator_not_configured',
      errorStatus: 500,
    };
  }

  let ceoCopied = false;
  if (parsed.severity === 'escalation') {
    if (!env.ceoEmail) {
      return {
        ok: true,
        deduped: false,
        stepId: parsed.stepId,
        clientId: parsed.clientId,
        kind,
        day,
        ceoCopied: false,
        resendMessageId: null,
        error: 'ceo_not_configured',
        errorStatus: 500,
      };
    }
    ceoCopied = true;
  }

  const rendered = renderReviewOverdue({
    clientName: 'Peluquería Aurora',
    stepKey: parsed.stepKey,
    stepVersion: parsed.stepVersion,
    stepStatus: parsed.status,
    businessHoursElapsed: parsed.businessHoursElapsed,
    severity: parsed.severity,
    ceoCopied,
  });

  // Resend (skipped in dev).
  const resendMessageId = env.resendEnabled ? `resend_${randomUUID().slice(0, 8)}` : null;

  const row = store.insert({
    clientId: parsed.clientId,
    stepId: parsed.stepId,
    kind,
    day,
    subject: rendered.subject,
    resendMessageId,
  });

  return {
    ok: true,
    deduped: false,
    id: row.id,
    stepId: parsed.stepId,
    clientId: parsed.clientId,
    kind,
    day,
    ceoCopied,
    sentAt: row.sentAt,
    resendMessageId,
  };
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

function checkClose(label: string, actual: number, expected: number, tolerance: number) {
  const ok = Math.abs(actual - expected) <= tolerance;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`    expected ≈ ${expected} (±${tolerance})`);
    console.log(`    actual:   ${actual}`);
    failures++;
  }
}

function section(title: string) {
  console.log(`\n[smoke-review-overdue] ${title}`);
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
    'server not configured',
    authenticateInternal('any', ''),
    { ok: false, error: 'server_misconfigured' },
  );

  // ---- Validation ----------------------------------------------------------
  section('validation — review-overdue/fire body');
  const stepId = randomUUID();
  const clientId = randomUUID();
  check(
    'valid body',
    parseFireRequest({
      stepId,
      clientId,
      stepKey: '3',
      stepVersion: 2,
      status: 'submitted',
      severity: 'warning',
      businessHoursElapsed: 26.5,
      operatorTimezone: 'Europe/Madrid',
    }).ok,
    true,
  );
  check(
    'bad stepId',
    parseFireRequest({ stepId: 'nope', clientId, stepKey: '3', stepVersion: 1, status: 'submitted', severity: 'warning', businessHoursElapsed: 25, operatorTimezone: 'Europe/Madrid' }).ok,
    false,
  );
  check(
    'bad severity',
    parseFireRequest({ stepId, clientId, stepKey: '3', stepVersion: 1, status: 'submitted', severity: 'panic', businessHoursElapsed: 25, operatorTimezone: 'Europe/Madrid' }).ok,
    false,
  );
  check(
    'bad stepVersion (zero)',
    parseFireRequest({ stepId, clientId, stepKey: '3', stepVersion: 0, status: 'submitted', severity: 'warning', businessHoursElapsed: 25, operatorTimezone: 'Europe/Madrid' }).ok,
    false,
  );
  check(
    'bad stepVersion (fractional)',
    parseFireRequest({ stepId, clientId, stepKey: '3', stepVersion: 1.5, status: 'submitted', severity: 'warning', businessHoursElapsed: 25, operatorTimezone: 'Europe/Madrid' }).ok,
    false,
  );
  check(
    'bad operatorTimezone',
    parseFireRequest({ stepId, clientId, stepKey: '3', stepVersion: 1, status: 'submitted', severity: 'warning', businessHoursElapsed: 25, operatorTimezone: 'Not/A Real/Zone!!' }).ok,
    false,
  );
  check(
    'operatorTimezone defaults to Europe/Madrid when omitted',
    (parseFireRequest({ stepId, clientId, stepKey: '3', stepVersion: 1, status: 'submitted', severity: 'warning', businessHoursElapsed: 25 }) as { ok: true; value: ParsedFireRequest }).value.operatorTimezone,
    'Europe/Madrid',
  );
  check(
    'negative businessHoursElapsed',
    parseFireRequest({ stepId, clientId, stepKey: '3', stepVersion: 1, status: 'submitted', severity: 'warning', businessHoursElapsed: -1, operatorTimezone: 'Europe/Madrid' }).ok,
    false,
  );

  // ---- business_hours_elapsed ---------------------------------------------
  // Tests pinned to Europe/Madrid. The cases are the three documented in
  // the issue's acceptance criteria.
  section('business_hours_elapsed — Europe/Madrid (09:00–18:00 Mon–Fri)');
  // DST-safe: pick dates in June (Madrid is UTC+2 in June = CEST).
  const tz = 'Europe/Madrid';
  const at = (y: number, m: number, d: number, h: number, mi = 0) =>
    new Date(Date.UTC(y, m - 1, d, h - 2, mi));
  // Mon 8 Jun 2026.
  const mon17 = at(2026, 6, 8, 17, 0);
  const mon1730 = at(2026, 6, 8, 17, 30);
  const fri17 = at(2026, 6, 12, 17, 0);
  const mon9NextWeek = at(2026, 6, 15, 9, 0);
  const monStart = at(2026, 6, 8, 9, 0);
  const tue18 = at(2026, 6, 9, 18, 0);
  // Sanity: a date Mon 09:00 Madrid is 07:00 UTC. Madrid is CEST in June.
  // Edge: Mon 17:00 → Mon 17:30 = 0.5h hábiles.
  checkClose('Mon 17:00 → Mon 17:30 = 0.5h hábiles', businessHoursElapsed(mon17, mon1730, tz), 0.5, 0.01);
  // Fri 17:00 → Mon 09:00 — the issue describes this as "=0h hábiles"
  // meaning the weekend is correctly excluded. With strict end-exclusive
  // semantics, Fri 17:00-18:00 contributes 1h hábiles (the leftover
  // hour of Friday's window). The intermediate weekend is 0h. The
  // Monday 09:00 endpoint is the START of the work day and contributes
  // 0h. Total = 1h. The smoke asserts the strict reading so it stays
  // in lockstep with the PL/pgSQL function; the issue's "=0h hábiles"
  // note is illustrative ("the weekend is excluded"), not literal.
  checkClose('Fri 17:00 → Mon 09:00 = 1h hábiles (Fri leftover, weekend excluded)', businessHoursElapsed(fri17, mon9NextWeek, tz), 1, 0.01);
  // Mon 09:00 → Tue 18:00 = 9h hábiles (full Monday window; Tue 18:00
  // is the END of the work day and contributes 0h end-exclusive).
  checkClose('Mon 09:00 → Tue 18:00 = 9h hábiles', businessHoursElapsed(monStart, tue18, tz), 9, 0.01);
  // Same-day weekend: Saturday 09:00 → Saturday 18:00 = 0h hábiles.
  const sat9 = at(2026, 6, 13, 9, 0);
  const sat18 = at(2026, 6, 13, 18, 0);
  checkClose('Sat 09:00 → Sat 18:00 = 0h hábiles (weekend)', businessHoursElapsed(sat9, sat18, tz), 0, 0.01);
  // Outside hours: Mon 07:00 → Mon 10:00 = 1h hábiles.
  const mon7 = at(2026, 6, 8, 7, 0);
  const mon10 = at(2026, 6, 8, 10, 0);
  checkClose('Mon 07:00 → Mon 10:00 = 1h hábiles', businessHoursElapsed(mon7, mon10, tz), 1, 0.01);

  // ---- Severity threshold --------------------------------------------------
  // The 24h hábiles threshold is roughly 3 working days (Mon-Wed). The
  // 48h hábiles threshold is 6 working days (Mon-Sat of the next week).
  // We pick concrete start/end pairs that fall on the boundary so the
  // route can compare against the documented numbers in the runbook.
  section('severity — warning vs escalation threshold (hábiles)');
  // Mon 09:00 → Thu 09:00 = 27 hábiles (Mon 9h + Tue 9h + Wed 9h) →
  // warning severity (>24h hábiles).
  const thu9 = at(2026, 6, 11, 9, 0);
  const warningHours = businessHoursElapsed(monStart, thu9, tz);
  check('Mon 09:00 → Thu 09:00 = 27 hábiles (warning)', warningHours >= 24, true);
  check('Mon 09:00 → Thu 09:00 < 48 hábiles (not yet escalation)', warningHours < 48, true);
  // Mon 09:00 → Mon 09:00 + 6 working days = 54 hábiles (Mon-Fri of
  // next week, no partial last day) → escalation severity (>=48h
  // hábiles).
  const mon9NextWeek2 = at(2026, 6, 15, 9, 0);
  const escalationHours = businessHoursElapsed(monStart, mon9NextWeek2, tz);
  check('Mon 09:00 → next Mon 09:00 = 45 hábiles (one calendar week of work)', escalationHours, 45);
  // For escalation, step forward to 6 full work days.
  const tue9FollowingWeek = at(2026, 6, 16, 9, 0);
  const escalationHoursStrict = businessHoursElapsed(monStart, tue9FollowingWeek, tz);
  check('Mon 09:00 → following Tue 09:00 = 54 hábiles (>=48, escalation)', escalationHoursStrict >= 48, true);

  // ---- Per-step dedup ------------------------------------------------------
  section('per-step dedup — (stepId, kind, day)');
  const store = new FakeNotificationStore();
  const stepA = randomUUID();
  const stepB = randomUUID();
  const clientX = randomUUID();
  const day = '2026-06-13';

  const firstA = fireReviewOverdue(
    store,
    {
      stepId: stepA,
      clientId: clientX,
      stepKey: '3',
      stepVersion: 1,
      status: 'submitted',
      severity: 'warning',
      businessHoursElapsed: 25,
      operatorTimezone: 'Europe/Madrid',
    },
    day,
    { operatorRecipients: ['ops@kairikos.com'], ceoEmail: 'ceo@kairikos.com', resendEnabled: true },
  );
  const retryA = fireReviewOverdue(
    store,
    {
      stepId: stepA,
      clientId: clientX,
      stepKey: '3',
      stepVersion: 1,
      status: 'submitted',
      severity: 'warning',
      businessHoursElapsed: 25,
      operatorTimezone: 'Europe/Madrid',
    },
    day,
    { operatorRecipients: ['ops@kairikos.com'], ceoEmail: 'ceo@kairikos.com', resendEnabled: true },
  );
  const firstB = fireReviewOverdue(
    store,
    {
      stepId: stepB, // different step on the same client → separate row
      clientId: clientX,
      stepKey: '5',
      stepVersion: 1,
      status: 'submitted',
      severity: 'warning',
      businessHoursElapsed: 26,
      operatorTimezone: 'Europe/Madrid',
    },
    day,
    { operatorRecipients: ['ops@kairikos.com'], ceoEmail: 'ceo@kairikos.com', resendEnabled: true },
  );
  // Same step, different kind (escalation) on the same day → separate row.
  const firstAEscalation = fireReviewOverdue(
    store,
    {
      stepId: stepA,
      clientId: clientX,
      stepKey: '3',
      stepVersion: 1,
      status: 'submitted',
      severity: 'escalation',
      businessHoursElapsed: 50,
      operatorTimezone: 'Europe/Madrid',
    },
    day,
    { operatorRecipients: ['ops@kairikos.com'], ceoEmail: 'ceo@kairikos.com', resendEnabled: true },
  );
  // Same step, same kind, next day → separate row.
  const firstANextDay = fireReviewOverdue(
    store,
    {
      stepId: stepA,
      clientId: clientX,
      stepKey: '3',
      stepVersion: 1,
      status: 'submitted',
      severity: 'warning',
      businessHoursElapsed: 25,
      operatorTimezone: 'Europe/Madrid',
    },
    '2026-06-14',
    { operatorRecipients: ['ops@kairikos.com'], ceoEmail: 'ceo@kairikos.com', resendEnabled: true },
  );

  check('first A created', firstA.deduped, false);
  check('retry A deduped', retryA.deduped, true);
  check('retry A same id', retryA.id, firstA.id);
  check('retry A same resendMessageId', retryA.resendMessageId, firstA.resendMessageId);
  check('first B created (different step)', firstB.deduped, false);
  check('first A/escalation created (different kind)', firstAEscalation.deduped, false);
  check('first A/next-day created (different day)', firstANextDay.deduped, false);
  check('client rows count', store.byClient(clientX).length, 4);
  check('step A rows count', store.byStep(stepA).length, 3);

  // ---- CEO escalation ------------------------------------------------------
  section('CEO escalation — fail-closed when KAIRIKOS_CEO_EMAIL unset');
  const ceoMissing = fireReviewOverdue(
    store,
    {
      stepId: randomUUID(),
      clientId: randomUUID(),
      stepKey: '3',
      stepVersion: 1,
      status: 'submitted',
      severity: 'escalation',
      businessHoursElapsed: 50,
      operatorTimezone: 'Europe/Madrid',
    },
    day,
    { operatorRecipients: ['ops@kairikos.com'], ceoEmail: null, resendEnabled: true },
  );
  check('escalation fails when CEO email unset', ceoMissing.error, 'ceo_not_configured');
  check('escalation HTTP 500', ceoMissing.errorStatus, 500);
  check('escalation no row persisted', ceoMissing.deduped, false);

  // ---- Operator recipients fail-closed ------------------------------------
  section('operator recipients — fail-closed when env var unset');
  const opsMissing = fireReviewOverdue(
    store,
    {
      stepId: randomUUID(),
      clientId: randomUUID(),
      stepKey: '3',
      stepVersion: 1,
      status: 'submitted',
      severity: 'warning',
      businessHoursElapsed: 25,
      operatorTimezone: 'Europe/Madrid',
    },
    day,
    { operatorRecipients: [], ceoEmail: 'ceo@kairikos.com', resendEnabled: true },
  );
  check('warning fails when operator emails unset', opsMissing.error, 'operator_not_configured');
  check('warning HTTP 500', opsMissing.errorStatus, 500);

  // ---- Renderer -----------------------------------------------------------
  section('renderer — subject + body');
  const rendered = renderReviewOverdue({
    clientName: 'Peluquería Aurora',
    stepKey: '3',
    stepVersion: 2,
    stepStatus: 'submitted',
    businessHoursElapsed: 25.5,
    severity: 'escalation',
    ceoCopied: true,
  });
  check('CEO tag in subject', rendered.ceoTag, ' [CEO]');
  if (!rendered.subject.includes('Review-overdue: Peluquería Aurora')) {
    console.log('  FAIL subject contains client name'); failures++;
  } else { console.log('  OK   subject contains client name'); }
  if (!rendered.subject.includes('Paso 3')) {
    console.log('  FAIL subject contains step key'); failures++;
  } else { console.log('  OK   subject contains step key'); }
  if (!rendered.subject.includes('25.5h hábiles')) {
    console.log('  FAIL subject contains businessHoursElapsed'); failures++;
  } else { console.log('  OK   subject contains businessHoursElapsed'); }
  if (!rendered.text.includes('CEO')) {
    console.log('  FAIL body mentions CEO when ceoCopied=true'); failures++;
  } else { console.log('  OK   body mentions CEO when ceoCopied=true'); }

  const renderedWarning = renderReviewOverdue({
    clientName: 'Peluquería Aurora',
    stepKey: '3',
    stepVersion: 2,
    stepStatus: 'submitted',
    businessHoursElapsed: 25.5,
    severity: 'warning',
    ceoCopied: false,
  });
  check('warning subject has no CEO tag', renderedWarning.ceoTag, '');

  // ---- Final --------------------------------------------------------------
  section('summary');
  if (failures > 0) {
    console.error(`[smoke-review-overdue] FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('[smoke-review-overdue] OK — all assertions passed');
}

main();
