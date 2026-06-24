// =============================================================================
// KAIA-1177 — smoke test for the wizard-abandoned endpoints
//   POST /api/internal/wizard-abandoned/scan
//   POST /api/internal/wizard-abandoned/fire
//
// Exercises the auth, validation, dedup, and recovery-email contract
// without a live HTTP server or docker. Self-contained: inlines copies
// of the validation, the in-memory Prisma stand-in (FakeActivityStore),
// the recovery-email renderer, and the dedup logic. Mirrors the
// production code in:
//   * src/lib/internal-auth.ts
//   * src/lib/wizard-recovery-email.ts
//   * src/app/api/internal/wizard-abandoned/scan/route.ts
//   * src/app/api/internal/wizard-abandoned/fire/route.ts
//
// Run:   npx tsx scripts/smoke-wizard-abandoned.ts
// Exit:  0 on success, 1 on any failure (logs the first failing assertion).
// =============================================================================

import { randomUUID } from 'node:crypto';

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// -----------------------------------------------------------------------------
// Inlined auth + validation (mirrors the production routes).
// -----------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIZARD_STEP_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'] as const;
type WizardStepKey = (typeof WIZARD_STEP_KEYS)[number];

function isWizardStepKey(v: string): v is WizardStepKey {
  return (WIZARD_STEP_KEYS as readonly string[]).includes(v);
}

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

interface ParsedFireRequest {
  clientId: string;
  lastDraftAt: Date;
  lastStepKey: string;
  hoursSinceLastDraft: number;
}

function parseFireRequest(body: unknown): Result<ParsedFireRequest, string> {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const { clientId, lastDraftAt, lastStepKey, hoursSinceLastDraft } = b;

  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
    return { ok: false, error: 'clientId must be a UUID string' };
  }
  if (typeof lastDraftAt !== 'string') {
    return { ok: false, error: 'lastDraftAt must be an ISO-8601 string' };
  }
  const lastDraftDate = new Date(lastDraftAt);
  if (Number.isNaN(lastDraftDate.getTime())) {
    return { ok: false, error: 'lastDraftAt must be a valid date' };
  }
  if (typeof lastStepKey !== 'string' || !isWizardStepKey(lastStepKey)) {
    return {
      ok: false,
      error: `lastStepKey must be one of ${WIZARD_STEP_KEYS.join(', ')}`,
    };
  }
  if (
    typeof hoursSinceLastDraft !== 'number' ||
    !Number.isFinite(hoursSinceLastDraft) ||
    hoursSinceLastDraft < 0
  ) {
    return {
      ok: false,
      error: 'hoursSinceLastDraft must be a non-negative number',
    };
  }
  return {
    ok: true,
    value: { clientId, lastDraftAt: lastDraftDate, lastStepKey, hoursSinceLastDraft },
  };
}

// -----------------------------------------------------------------------------
// Inlined recovery-email renderer (mirrors src/lib/wizard-recovery-email.ts).
// Used by the smoke to assert the email shape without calling Resend.
// -----------------------------------------------------------------------------

const STEP_HUMAN: Record<WizardStepKey, string> = {
  '1': 'Perfil del negocio',
  '2': 'Servicios y horarios',
  '3': 'Idioma y tono',
  '4': 'Preguntas frecuentes',
  '5': 'Reglas de escalado',
  '6': 'Integraciones',
  '7': 'Horarios del bot',
  '8': 'Políticas de privacidad',
  '9': 'Casos especiales',
  '10': 'Cumplimiento',
  '11': 'Pruebas',
};

function buildRecoveryEmail(vars: {
  clientFirstName: string;
  lastStepKey: string;
  lastStepHuman: string;
  hoursSinceLastDraft: number;
  portalUrl: string;
}) {
  const subject = 'Hemos parado a medias con tu configuración — ¿sigues por aquí?';
  const portalLink = `${vars.portalUrl}/portal/wizard?step=${vars.lastStepKey}`;
  const text = [
    `Hola ${vars.clientFirstName},`,
    '',
    `Vimos que empezaste a configurar tu chatbot en Kairikos y que te quedaste en el Paso ${vars.lastStepKey} (${vars.lastStepHuman}). Llevas ${vars.hoursSinceLastDraft} horas sin tocarlo.`,
    '',
    `No te preocupes: tu progreso está guardado. Puedes seguir donde lo dejaste entrando a ${portalLink} — tardarás menos de 5 minutos en terminar.`,
    '',
    'Si te atascaste en algo o prefieres que te llamemos, responde a este email y un humano del equipo te ayuda.',
    '',
    '— El equipo de Kairikos',
  ].join('\n');
  return { subject, text, portalLink };
}

// -----------------------------------------------------------------------------
// In-memory Prisma stand-in for ChatbotActivity. Emulates the production
// (clientId, milestone) unique constraint and tracks a "resendMessageId"
// per row so the smoke can assert the same row id on retry.
// -----------------------------------------------------------------------------

interface ActivityRow {
  id: string;
  clientId: string;
  milestone: string;
  completedAt: string;
  notes: string | null;
}

class FakeActivityStore {
  private rows: ActivityRow[] = [];
  private byKey = new Map<string, ActivityRow>();

  private key(clientId: string, milestone: string) {
    return `${clientId}::${milestone}`;
  }

  upsert(input: {
    clientId: string;
    milestone: string;
    completedAt: Date;
    notes: string | null;
  }): { row: ActivityRow; created: boolean } {
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

  findUnique(clientId: string, milestone: string): ActivityRow | undefined {
    return this.byKey.get(this.key(clientId, milestone));
  }

  findByClient(clientId: string): ActivityRow[] {
    return this.rows.filter((r) => r.clientId === clientId);
  }
}

// -----------------------------------------------------------------------------
// "Fire" handler — mirrors the production route's logic minus the DB
// round trip. Returns the same response shape the route returns.
// -----------------------------------------------------------------------------

interface FireResponse {
  ok: true;
  deduped: boolean;
  id: string;
  clientId: string;
  milestone: string;
  lastStepKey: string;
  hoursSinceLastDraft: number;
  resendMessageId: string | null;
  skipped?: 'no_api_key' | 'no_recipient';
}

function fireWizardAbandoned(
  store: FakeActivityStore,
  input: ParsedFireRequest,
  resendEnabled: boolean,
): FireResponse {
  const existing = store.findUnique(input.clientId, 'wizard_abandoned');
  if (existing) {
    const messageId = extractResendMessageId(existing.notes);
    return {
      ok: true,
      deduped: true,
      id: existing.id,
      clientId: existing.clientId,
      milestone: existing.milestone,
      lastStepKey: input.lastStepKey,
      hoursSinceLastDraft: input.hoursSinceLastDraft,
      resendMessageId: messageId,
    };
  }

  const lastStepHuman = STEP_HUMAN[input.lastStepKey as WizardStepKey];
  const rendered = buildRecoveryEmail({
    clientFirstName: 'Aurora',
    lastStepKey: input.lastStepKey,
    lastStepHuman,
    hoursSinceLastDraft: Math.round(input.hoursSinceLastDraft),
    portalUrl: 'https://portal.kairikos.com',
  });

  // In production the route calls Resend via the runtime require; here
  // we just record the would-be messageId. resendEnabled=false mirrors
  // dev with no RESEND_API_KEY.
  const resendMessageId = resendEnabled ? `resend_${randomUUID().slice(0, 8)}` : null;
  const skipped: 'no_api_key' | 'no_recipient' | undefined = resendEnabled
    ? undefined
    : 'no_api_key';

  const notes = JSON.stringify({
    subject: rendered.subject,
    template: 'wizard-recovery-v0',
    resendMessageId,
    lastStepKey: input.lastStepKey,
    lastStepHuman,
    hoursSinceLastDraft: Math.round(input.hoursSinceLastDraft),
    skipped,
  });

  const { row, created } = store.upsert({
    clientId: input.clientId,
    milestone: 'wizard_abandoned',
    completedAt: new Date(),
    notes,
  });

  return {
    ok: true,
    deduped: !created,
    id: row.id,
    clientId: row.clientId,
    milestone: row.milestone,
    lastStepKey: input.lastStepKey,
    hoursSinceLastDraft: input.hoursSinceLastDraft,
    resendMessageId,
    skipped,
  };
}

function extractResendMessageId(notes: string | null): string | null {
  if (!notes) return null;
  try {
    const parsed = JSON.parse(notes) as { resendMessageId?: unknown };
    return typeof parsed.resendMessageId === 'string' ? parsed.resendMessageId : null;
  } catch {
    return null;
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

function checkTruthy(label: string, actual: unknown) {
  const ok = Boolean(actual);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`    expected truthy, got: ${JSON.stringify(actual)}`);
    failures++;
  }
}

function section(title: string) {
  console.log(`\n[smoke-wizard-abandoned] ${title}`);
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

  // ---- Validation ----------------------------------------------------------
  section('validation — wizard-abandoned/fire body');
  const okId = randomUUID();
  check(
    'valid body',
    parseFireRequest({
      clientId: okId,
      lastDraftAt: '2026-06-10T11:42:00.000Z',
      lastStepKey: '3',
      hoursSinceLastDraft: 72,
    }).ok,
    true,
  );
  check(
    'bad clientId',
    parseFireRequest({ clientId: 'not-a-uuid', lastDraftAt: '2026-06-10T11:42:00.000Z', lastStepKey: '3', hoursSinceLastDraft: 72 }).ok,
    false,
  );
  check(
    'bad lastDraftAt',
    parseFireRequest({ clientId: okId, lastDraftAt: 'not-a-date', lastStepKey: '3', hoursSinceLastDraft: 72 }).ok,
    false,
  );
  check(
    'bad lastStepKey (12 is v1.1, out of scope)',
    parseFireRequest({ clientId: okId, lastDraftAt: '2026-06-10T11:42:00.000Z', lastStepKey: '12', hoursSinceLastDraft: 72 }).ok,
    false,
  );
  check(
    'bad lastStepKey (non-numeric)',
    parseFireRequest({ clientId: okId, lastDraftAt: '2026-06-10T11:42:00.000Z', lastStepKey: 'wizard-step-3', hoursSinceLastDraft: 72 }).ok,
    false,
  );
  check(
    'negative hoursSinceLastDraft',
    parseFireRequest({ clientId: okId, lastDraftAt: '2026-06-10T11:42:00.000Z', lastStepKey: '3', hoursSinceLastDraft: -1 }).ok,
    false,
  );
  check(
    'NaN hoursSinceLastDraft',
    parseFireRequest({ clientId: okId, lastDraftAt: '2026-06-10T11:42:00.000Z', lastStepKey: '3', hoursSinceLastDraft: 'lots' }).ok,
    false,
  );

  // ---- Idempotency + Resend integration -----------------------------------
  section('idempotency — wizard-abandoned/fire upsert collapses retries');
  const store = new FakeActivityStore();
  const clientA = randomUUID();
  const clientB = randomUUID();

  const firstA = fireWizardAbandoned(
    store,
    {
      clientId: clientA,
      lastDraftAt: new Date('2026-06-10T11:42:00Z'),
      lastStepKey: '3',
      hoursSinceLastDraft: 72,
    },
    /* resendEnabled */ true,
  );
  const retryA = fireWizardAbandoned(
    store,
    {
      clientId: clientA,
      lastDraftAt: new Date('2026-06-10T11:42:00Z'),
      lastStepKey: '3',
      hoursSinceLastDraft: 72,
    },
    /* resendEnabled */ true,
  );
  const firstB = fireWizardAbandoned(
    store,
    {
      clientId: clientB,
      lastDraftAt: new Date('2026-06-10T11:42:00Z'),
      lastStepKey: '5',
      hoursSinceLastDraft: 50,
    },
    /* resendEnabled */ true,
  );

  check('first A created', firstA.deduped, false);
  check('retry A did NOT re-send', retryA.deduped, true);
  check('retry A returned same id', retryA.id, firstA.id);
  check('retry A returned the original resendMessageId', retryA.resendMessageId, firstA.resendMessageId);
  check('first B created (different client)', firstB.deduped, false);
  check('client A row count', store.findByClient(clientA).length, 1);
  check('client B row count', store.findByClient(clientB).length, 1);
  checkTruthy('resendMessageId present when Resend is enabled', firstA.resendMessageId);

  // ---- Dev path: Resend disabled ------------------------------------------
  section('dev path — RESEND_API_KEY unset, resend skipped');
  const store2 = new FakeActivityStore();
  const devFire = fireWizardAbandoned(
    store2,
    {
      clientId: randomUUID(),
      lastDraftAt: new Date('2026-06-10T11:42:00Z'),
      lastStepKey: '1',
      hoursSinceLastDraft: 96,
    },
    /* resendEnabled */ false,
  );
  check('dev fire ok', devFire.ok, true);
  check('dev fire deduped=false on first call', devFire.deduped, false);
  check('dev fire skipped=no_api_key', devFire.skipped, 'no_api_key');
  check('dev fire resendMessageId=null', devFire.resendMessageId, null);
  check('dev fire still persisted row', store2.findByClient(devFire.clientId).length, 1);

  // ---- Recovery email shape ------------------------------------------------
  section('recovery email — Kira-voice v0 copy');
  const rendered = buildRecoveryEmail({
    clientFirstName: 'Aurora',
    lastStepKey: '3',
    lastStepHuman: STEP_HUMAN['3'],
    hoursSinceLastDraft: 72,
    portalUrl: 'https://portal.kairikos.com',
  });
  check(
    'subject is the v0 line',
    rendered.subject,
    'Hemos parado a medias con tu configuración — ¿sigues por aquí?',
  );
  if (!rendered.text.includes('Hola Aurora,')) {
    console.log('  FAIL recovery email greets client');
    failures++;
  } else {
    console.log('  OK   recovery email greets client');
  }
  if (!rendered.text.includes('Paso 3 (Idioma y tono)')) {
    console.log('  FAIL recovery email mentions step + human label');
    failures++;
  } else {
    console.log('  OK   recovery email mentions step + human label');
  }
  if (!rendered.text.includes('72 horas sin tocarlo')) {
    console.log('  FAIL recovery email mentions hoursSinceLastDraft');
    failures++;
  } else {
    console.log('  OK   recovery email mentions hoursSinceLastDraft');
  }
  if (!rendered.text.includes('https://portal.kairikos.com/portal/wizard?step=3')) {
    console.log('  FAIL recovery email mentions portal link with step');
    failures++;
  } else {
    console.log('  OK   recovery email mentions portal link with step');
  }

  // ---- Final --------------------------------------------------------------
  section('summary');
  if (failures > 0) {
    console.error(`[smoke-wizard-abandoned] FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('[smoke-wizard-abandoned] OK — all assertions passed');
}

main();
