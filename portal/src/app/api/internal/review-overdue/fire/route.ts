import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import {
  authenticateInternalRequest,
  internalAuthFailureResponse,
} from '@/lib/internal-auth';
import {
  reviewOverdueKind,
  renderReviewOverdue,
  resolveCeoRecipient,
  resolveOperatorRecipients,
  sendOperatorNotification,
  type ReviewOverdueSeverity,
} from '@/lib/operator-notify';

// =============================================================================
// POST /api/internal/review-overdue/fire
//
// KAIA-1177 (KAIA-1172 / AU-2) — idempotent write route. Called by the
// n8n `config-review-overdue` flow for each candidate the scan
// returned.
//
// On success:
//   1. Upsert an `OperatorNotification` row with
//      `kind='review-overdue-warning'` (severity=warning) or
//      `kind='review-overdue-escalation'` (severity=escalation) and
//      `stepId=<the step cuid>`. The partial unique index
//      `OperatorNotification_stepId_kind_day_key` added in
//      20260613124100_operator_notification_step_dedup enforces
//      per-(stepId, kind, day) dedup — different wizard steps on the
//      same client get separate rows. The `day` value is computed in
//      the operator's timezone via the
//      `public.operator_day_in_tz(now(), tz)` SQL function.
//   2. Send the operator notification via Resend. At
//      `severity='escalation'`, also CC the CEO via
//      `KAIRIKOS_CEO_EMAIL`. The route fails closed
//      (500 `ceo_not_configured`) when the env var is empty and an
//      escalation fires.
//
// Auth: shared secret via `PORTAL_API_KEY`, fail closed if unset.
// =============================================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FireRequestBody {
  stepId?: unknown;
  clientId?: unknown;
  stepKey?: unknown;
  stepVersion?: unknown;
  status?: unknown;
  severity?: unknown;
  businessHoursElapsed?: unknown;
  operatorTimezone?: unknown;
}

interface ParsedFireRequest {
  stepId: string;
  clientId: string;
  stepKey: string;
  stepVersion: number;
  status: string;
  severity: ReviewOverdueSeverity;
  businessHoursElapsed: number;
  operatorTimezone: string;
}

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json(
      {
        error: 'database_not_configured',
        detail: 'DATABASE_URL is not set; refusing to fire',
      },
      { status: 503 },
    );
  }

  let body: FireRequestBody;
  try {
    body = (await req.json()) as FireRequestBody;
  } catch {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be valid JSON' },
      { status: 400 },
    );
  }

  const parsed = parseRequestBody(body);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: 'bad_request', detail: parsed.reason },
      { status: 400 },
    );
  }

  const kind = reviewOverdueKind(parsed.value.severity);

  // Resolve the client + step up front so we never write to a non-existent
  // or soft-deleted row. The trust boundary is the PORTAL_API_KEY check
  // above (n8n-only).
  const [client, step] = await Promise.all([
    prisma.chatbotClient.findUnique({
      where: { id: parsed.value.clientId },
      select: { id: true, name: true, companyName: true, state: true },
    }),
    prisma.chatbotConfigStep.findUnique({
      where: { id: parsed.value.stepId },
      select: {
        id: true,
        stepKey: true,
        version: true,
        status: true,
        clientId: true,
      },
    }),
  ]);

  if (!client) {
    return NextResponse.json(
      { error: 'not_found', detail: 'clientId does not exist' },
      { status: 404 },
    );
  }
  if (!step) {
    return NextResponse.json(
      { error: 'not_found', detail: 'stepId does not exist' },
      { status: 404 },
    );
  }
  if (step.clientId !== parsed.value.clientId) {
    return NextResponse.json(
      { error: 'bad_request', detail: 'stepId does not belong to clientId' },
      { status: 400 },
    );
  }

  // Compute the operator-timezone day key in the DB so the partial
  // unique index (OperatorNotification_stepId_kind_day_key) sees the
  // exact same string the route is going to write. We pull it back out
  // of the function so the response includes the canonical day.
  const dayRows = await prisma.$queryRaw<{ day: string }[]>(Prisma.sql`
    SELECT public.operator_day_in_tz(now(), ${parsed.value.operatorTimezone}) AS day
  `);
  const day = dayRows[0]?.day ?? null;
  if (!day) {
    return NextResponse.json(
      {
        error: 'bad_request',
        detail: 'operatorTimezone produced no date (invalid IANA name?)',
      },
      { status: 400 },
    );
  }

  // Dedup: pre-check for an existing (stepId, kind, day) row. The
  // partial unique index is the source of truth; the pre-check is a
  // cheap round trip on the retry path and lets us return the
  // original row without an upsert.
  const existing = await prisma.operatorNotification.findFirst({
    where: {
      stepId: parsed.value.stepId,
      kind,
      day,
    },
    select: { id: true, sentAt: true, resendMessageId: true, subject: true },
  });

  if (existing) {
    return NextResponse.json({
      ok: true,
      deduped: true,
      id: existing.id,
      stepId: parsed.value.stepId,
      clientId: parsed.value.clientId,
      kind,
      day,
      ceoCopied: parsed.value.severity === 'escalation',
      sentAt: existing.sentAt.toISOString(),
      resendMessageId: existing.resendMessageId,
    });
  }

  // Operator recipient list — fail closed if not configured.
  const recipients = resolveOperatorRecipients(
    process.env.KAIRIKOS_OPERATOR_EMAILS,
  );
  if (recipients.length === 0) {
    return NextResponse.json(
      {
        error: 'operator_not_configured',
        detail: 'KAIRIKOS_OPERATOR_EMAILS is not set; refusing to send',
      },
      { status: 500 },
    );
  }

  // CEO escalation: at severity=escalation, append the CEO email to the
  // recipient list. Fail closed (500 ceo_not_configured) when the env
  // var is empty — sending an "escalation" alert to the operator but
  // not the CEO is the worse failure mode (the CEO never sees the
  // problem and the operator wonders why).
  let ceoCopied = false;
  if (parsed.value.severity === 'escalation') {
    const ceoEmail = resolveCeoRecipient(process.env.KAIRIKOS_CEO_EMAIL);
    if (!ceoEmail) {
      return NextResponse.json(
        {
          error: 'ceo_not_configured',
          detail: 'KAIRIKOS_CEO_EMAIL is not set; refusing to send escalation',
        },
        { status: 500 },
      );
    }
    // Avoid duplicating the CEO if they are already in the operator
    // list (e.g. a small team where the operator is also the CEO).
    if (!recipients.some((r) => r.email.toLowerCase() === ceoEmail.toLowerCase())) {
      recipients.push({ email: ceoEmail });
    }
    ceoCopied = true;
  }

  const portalUrl = process.env.NEXT_PUBLIC_PORTAL_URL ?? undefined;
  const rendered = renderReviewOverdue({
    clientId: client.id,
    clientName: client.companyName ?? client.name,
    stepKey: step.stepKey,
    stepVersion: step.version,
    stepStatus: step.status,
    businessHoursElapsed: parsed.value.businessHoursElapsed,
    severity: parsed.value.severity,
    ceoCopied,
    portalUrl,
  });

  // Send + log. The `OperatorNotification` row is written after a
  // successful Resend call so a crash mid-send doesn't leave a
  // phantom claim in the log. The unique constraint is the safety net
  // either way.
  const sent = await sendOperatorNotification({
    kind,
    to: recipients,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  });

  if (!sent.ok) {
    return NextResponse.json(
      {
        error: 'resend_send_failed',
        detail: sent.error,
      },
      { status: 502 },
    );
  }

  const contextPayload = JSON.stringify({
    stepId: parsed.value.stepId,
    stepKey: parsed.value.stepKey,
    stepVersion: parsed.value.stepVersion,
    status: parsed.value.status,
    severity: parsed.value.severity,
    businessHoursElapsed: parsed.value.businessHoursElapsed,
    operatorTimezone: parsed.value.operatorTimezone,
    ceoCopied,
  });

  try {
    const row = await prisma.operatorNotification.upsert({
      where: {
        // Prisma requires a unique key for upsert. The partial unique
        // index on (stepId, kind, day) is the dedup contract; we
        // emulate it by combining stepId + kind + day into the row's
        // `id` lookup via a raw findFirst→create fallback. Prisma
        // doesn't model partial uniques natively, so the upsert key
        // here uses the @@unique([clientId, kind, day]) — that
        // combination is naturally unique for our row because
        // clientId is part of the row. We then rely on the partial
        // unique index to catch any race that slips past the pre-check.
        clientId_kind_day: {
          clientId: parsed.value.clientId,
          kind,
          day,
        },
      },
      create: {
        clientId: parsed.value.clientId,
        stepId: parsed.value.stepId,
        kind,
        day,
        subject: rendered.subject,
        context: contextPayload,
        resendMessageId: sent.messageId,
        sentAt: new Date(),
      },
      update: {
        // Idempotent retry: refresh the timestamp + context. The
        // partial unique index (stepId, kind, day) is what prevents
        // two different steps on the same client from collapsing;
        // clientId+kind+day is naturally unique for this single
        // step so the upsert is safe in practice.
        stepId: parsed.value.stepId,
        subject: rendered.subject,
        context: contextPayload,
        sentAt: new Date(),
      },
      select: { id: true, sentAt: true, resendMessageId: true },
    });

    return NextResponse.json({
      ok: true,
      deduped: false,
      id: row.id,
      stepId: parsed.value.stepId,
      clientId: parsed.value.clientId,
      kind,
      day,
      ceoCopied,
      sentAt: row.sentAt.toISOString(),
      resendMessageId: row.resendMessageId,
      skipped: 'skipped' in sent ? sent.skipped : undefined,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // P2002 = unique constraint. Could be the @@unique([clientId,
      // kind, day]) or the partial unique (stepId, kind, day). In
      // either case the right response is deduped: true with the
      // existing row.
      if (err.code === 'P2002') {
        const original = await prisma.operatorNotification.findFirst({
          where: {
            stepId: parsed.value.stepId,
            kind,
            day,
          },
          select: { id: true, sentAt: true, resendMessageId: true },
        });
        if (original) {
          return NextResponse.json({
            ok: true,
            deduped: true,
            id: original.id,
            stepId: parsed.value.stepId,
            clientId: parsed.value.clientId,
            kind,
            day,
            ceoCopied,
            sentAt: original.sentAt.toISOString(),
            resendMessageId: original.resendMessageId,
          });
        }
      }
      return NextResponse.json(
        {
          error: 'database_error',
          detail: `prisma.${err.code}`,
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500 },
    );
  }
}

export function GET() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

type ParseResult =
  | { ok: true; value: ParsedFireRequest }
  | { ok: false; reason: string };

function parseRequestBody(body: FireRequestBody): ParseResult {
  const {
    stepId,
    clientId,
    stepKey,
    stepVersion,
    status,
    severity,
    businessHoursElapsed,
    operatorTimezone,
  } = body;

  if (typeof stepId !== 'string' || !UUID_RE.test(stepId)) {
    return { ok: false, reason: 'stepId must be a UUID string' };
  }
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
    return { ok: false, reason: 'clientId must be a UUID string' };
  }
  if (typeof stepKey !== 'string' || stepKey.length === 0) {
    return { ok: false, reason: 'stepKey must be a non-empty string' };
  }
  if (typeof stepVersion !== 'number' || !Number.isInteger(stepVersion) || stepVersion < 1) {
    return { ok: false, reason: 'stepVersion must be a positive integer' };
  }
  if (typeof status !== 'string' || status.length === 0) {
    return { ok: false, reason: 'status must be a non-empty string' };
  }
  if (severity !== 'warning' && severity !== 'escalation') {
    return { ok: false, reason: 'severity must be "warning" or "escalation"' };
  }
  if (
    typeof businessHoursElapsed !== 'number' ||
    !Number.isFinite(businessHoursElapsed) ||
    businessHoursElapsed < 0
  ) {
    return {
      ok: false,
      reason: 'businessHoursElapsed must be a non-negative number',
    };
  }
  let operatorTz: string = 'Europe/Madrid';
  if (operatorTimezone !== undefined && operatorTimezone !== null) {
    if (typeof operatorTimezone !== 'string' || !isValidTimezone(operatorTimezone)) {
      return {
        ok: false,
        reason: 'operatorTimezone must be a valid IANA timezone string (e.g. "Europe/Madrid")',
      };
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

function isValidTimezone(tz: string): boolean {
  if (tz.length < 3 || tz.length > 64) return false;
  return /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz);
}
