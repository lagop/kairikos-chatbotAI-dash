import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import {
  authenticateInternalRequest,
  internalAuthFailureResponse,
} from '@/lib/internal-auth';

// =============================================================================
// POST /api/internal/review-overdue/scan
//
// KAIA-1177 (KAIA-1172 / AU-2) — read-only scan route the n8n
// `config-review-overdue` flow calls every hour. Returns the set of
// `ChatbotConfigStep` rows in `submitted` (or `needs_revision` with a
// client response) whose business-hours elapsed since the relevant
// timestamp is >= 24h. The 48h hábiles threshold is the `escalation`
// severity boundary.
//
// The route is the only place that does the business-hours arithmetic —
// the `business_hours_elapsed` SQL function
// (migration 20260613123901_lifecycle_triggers_sql_functions) is the
// source of truth. n8n trusts the response and just dispatches.
//
// The operator timezone defaults to `Europe/Madrid` (Kairikos HQ) and
// can be overridden in the body so an operator in a different zone sees
// the SLA in their working hours.
//
// Auth: shared secret via `PORTAL_API_KEY`, fail closed if unset.
// =============================================================================

const DEFAULT_OPERATOR_TIMEZONE = 'Europe/Madrid';
const REVIEW_OVERDUE_WARNING_HOURS = 24;
const REVIEW_OVERDUE_ESCALATION_HOURS = 48;

interface ScanCandidate {
  stepId: string;
  clientId: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  stepKey: string;
  stepVersion: number;
  status: string;
  submittedAt: string;
  clientRespondedAt: string | null;
  businessHoursElapsed: number;
  severity: 'warning' | 'escalation';
  alreadyFiredInWindow: boolean;
}

interface ScanRow {
  stepId: string;
  clientId: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  stepKey: string;
  stepVersion: number;
  status: string;
  submittedAt: Date;
  clientRespondedAt: Date | null;
  businessHoursElapsed: number;
  severity: 'warning' | 'escalation';
  alreadyFiredInWindow: boolean;
}

interface RawScanRow {
  stepId: string;
  clientId: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  stepKey: string;
  stepVersion: number;
  status: string;
  submittedAt: Date | string;
  clientRespondedAt: Date | string | null;
  businessHoursElapsed: number | string;
  severity: 'warning' | 'escalation';
  alreadyFiredInWindow: boolean;
}

export async function POST(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json(
      {
        error: 'database_not_configured',
        detail: 'DATABASE_URL is not set; refusing to scan',
      },
      { status: 503 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be valid JSON' },
      { status: 400 },
    );
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be a JSON object' },
      { status: 400 },
    );
  }

  const operatorTimezoneRaw = body.operatorTimezone;
  let operatorTimezone: string = DEFAULT_OPERATOR_TIMEZONE;
  if (operatorTimezoneRaw !== undefined && operatorTimezoneRaw !== null) {
    if (typeof operatorTimezoneRaw !== 'string' || !isValidTimezone(operatorTimezoneRaw)) {
      return NextResponse.json(
        {
          error: 'bad_request',
          detail: 'operatorTimezone must be a valid IANA timezone string (e.g. "Europe/Madrid")',
        },
        { status: 400 },
      );
    }
    operatorTimezone = operatorTimezoneRaw;
  }

  try {
    const rows = await scanReviewOverdue(operatorTimezone);
    const candidates: ScanCandidate[] = rows.map((row) => ({
      stepId: row.stepId,
      clientId: row.clientId,
      companyName: row.companyName,
      contactName: row.contactName,
      contactEmail: row.contactEmail,
      stepKey: row.stepKey,
      stepVersion: row.stepVersion,
      status: row.status,
      submittedAt: row.submittedAt.toISOString(),
      clientRespondedAt: row.clientRespondedAt ? row.clientRespondedAt.toISOString() : null,
      businessHoursElapsed: Math.round(row.businessHoursElapsed * 100) / 100,
      severity: row.severity,
      alreadyFiredInWindow: row.alreadyFiredInWindow,
    }));
    return NextResponse.json({
      ok: true,
      now: new Date().toISOString(),
      operatorTimezone,
      businessHours: {
        startHour: 9,
        endHour: 18,
        weekdays: [1, 2, 3, 4, 5],
      },
      candidates,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
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

/**
 * Run the review-overdue scan. Exported (named) so the smoke test
 * (scripts/smoke-review-overdue.ts) can reuse the in-memory logic
 * without going through Prisma.
 *
 * The SQL mirrors the runbook §3.2 contract:
 *
 *   1. Pick every ChatbotConfigStep in `submitted` (or
 *      `needs_revision` with a client response) on a client whose
 *      global state is still in flight (in-progress | go-live-pending
 *      — see the state-values note in wizard-abandoned/scan for the
 *      full explanation; we treat the two mid-wizard states as
 *      "still in flight" so review-overdue surfaces during the
 *      normal handoff window).
 *   2. Compute `measureFromAt`: the timestamp we measure "elapsed
 *      hábiles since" against. For `submitted` it's `submittedAt`;
 *      for `needs_revision` it's the most recent client edit after
 *      the operator's `request_revision` (falling back to
 *      `submittedAt`).
 *   3. Filter to rows whose `business_hours_elapsed(measureFromAt,
 *      now(), operator_timezone) >= 24`.
 *   4. Project `severity`: warning at 24–48h hábiles, escalation
 *      at >=48h hábiles.
 *   5. Project `alreadyFiredInWindow`: true when an
 *      `OperatorNotification` row exists for the same (stepId, kind,
 *      day) at the same severity (the partial unique index added in
 *      20260613124100_operator_notification_step_dedup).
 */
async function scanReviewOverdue(operatorTimezone: string): Promise<ScanRow[]> {
  const warningHours = REVIEW_OVERDUE_WARNING_HOURS;
  const escalationHours = REVIEW_OVERDUE_ESCALATION_HOURS;

  const rows = await prisma.$queryRaw<RawScanRow[]>(Prisma.sql`
    WITH submitted_steps AS (
      SELECT
        s.id            AS "stepId",
        s."clientId"    AS "clientId",
        s."stepKey"     AS "stepKey",
        s.version       AS "stepVersion",
        s.status        AS "status",
        s."submittedAt" AS "submittedAt",
        c."companyName" AS "companyName",
        c.email         AS "contactEmail",
        c.name          AS "contactName",
        CASE
          WHEN s.status = 'submitted' THEN s."submittedAt"
          WHEN s.status = 'needs_revision' THEN COALESCE((
            SELECT MAX(a."createdAt")
            FROM "ChatbotConfigStepAudit" a
            WHERE a."stepId" = s.id
              AND a.actor = 'client'
              AND a.action IN ('edit', 'submit')
              AND a."createdAt" > (
                SELECT MAX(a2."createdAt")
                FROM "ChatbotConfigStepAudit" a2
                WHERE a2."stepId" = s.id
                  AND a2.actor = 'operator'
                  AND a2.action = 'request_revision'
              )
          ), s."submittedAt")
        END AS "clientRespondedAt",
        CASE
          WHEN s.status = 'submitted' THEN s."submittedAt"
          WHEN s.status = 'needs_revision' THEN COALESCE((
            SELECT MAX(a."createdAt")
            FROM "ChatbotConfigStepAudit" a
            WHERE a."stepId" = s.id
              AND a.actor = 'client'
              AND a.action IN ('edit', 'submit')
              AND a."createdAt" > (
                SELECT MAX(a2."createdAt")
                FROM "ChatbotConfigStepAudit" a2
                WHERE a2."stepId" = s.id
                  AND a2.actor = 'operator'
                  AND a2.action = 'request_revision'
              )
          ), s."submittedAt")
        END AS "measureFromAt"
      FROM "ChatbotConfigStep" s
      JOIN "ChatbotClient" c ON c.id = s."clientId"
      WHERE
        (s.status = 'submitted'
         OR (s.status = 'needs_revision'
             AND EXISTS (
               SELECT 1 FROM "ChatbotConfigStepAudit" a
               WHERE a."stepId" = s.id
                 AND a.actor = 'client'
                 AND a."createdAt" > (
                   SELECT MAX(a2."createdAt")
                   FROM "ChatbotConfigStepAudit" a2
                   WHERE a2."stepId" = s.id
                     AND a2.actor = 'operator'
                     AND a2.action = 'request_revision'
                 )
             )
            )
        )
        AND c.state IN ('in-progress', 'go-live-pending')
    )
    SELECT
      ss."stepId"::text                                 AS "stepId",
      ss."clientId"::text                               AS "clientId",
      ss."companyName"                                  AS "companyName",
      ss."contactEmail"                                 AS "contactEmail",
      ss."contactName"                                  AS "contactName",
      ss."stepKey"                                      AS "stepKey",
      ss."stepVersion"                                  AS "stepVersion",
      ss.status                                         AS "status",
      ss."submittedAt"                                  AS "submittedAt",
      ss."clientRespondedAt"                            AS "clientRespondedAt",
      public.business_hours_elapsed(
        ss."measureFromAt", now(), ${operatorTimezone}
      )                                                AS "businessHoursElapsed",
      CASE
        WHEN public.business_hours_elapsed(
          ss."measureFromAt", now(), ${operatorTimezone}
        ) >= ${escalationHours}::numeric
          THEN 'escalation'
          ELSE 'warning'
      END                                               AS "severity",
      EXISTS (
        SELECT 1 FROM "OperatorNotification" n
        WHERE n."stepId" = ss."stepId"
          AND n.day = public.operator_day_in_tz(now(), ${operatorTimezone})
          AND ((n.kind = 'review-overdue-warning'
                AND public.business_hours_elapsed(
                  ss."measureFromAt", now(), ${operatorTimezone}
                ) < ${escalationHours}::numeric)
               OR (n.kind = 'review-overdue-escalation'
                   AND public.business_hours_elapsed(
                     ss."measureFromAt", now(), ${operatorTimezone}
                   ) >= ${escalationHours}::numeric))
      )                                                 AS "alreadyFiredInWindow"
    FROM submitted_steps ss
    WHERE
      public.business_hours_elapsed(
        ss."measureFromAt", now(), ${operatorTimezone}
      ) >= ${warningHours}::numeric
    ORDER BY ss."measureFromAt" ASC;
  `);

  return rows.map((row) => ({
    stepId: String(row.stepId),
    clientId: String(row.clientId),
    companyName: row.companyName,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    stepKey: row.stepKey,
    stepVersion: Number(row.stepVersion),
    status: row.status,
    submittedAt: new Date(row.submittedAt),
    clientRespondedAt: row.clientRespondedAt ? new Date(row.clientRespondedAt) : null,
    businessHoursElapsed: Number(row.businessHoursElapsed),
    severity: row.severity,
    alreadyFiredInWindow: Boolean(row.alreadyFiredInWindow),
  }));
}

/**
 * Cheap IANA timezone validation. Avoids the runtime cost of
 * `Intl.supportedValuesOf('timeZone')` (Node 18+) and keeps the
 * behavior portable. Postgres will reject the value with a
 * `database_error` if the IANA name is unknown; the route is fail
 * closed in that case.
 */
function isValidTimezone(tz: string): boolean {
  if (tz.length < 3 || tz.length > 64) return false;
  // IANA names use ASCII letters, digits, underscores, slashes, dashes,
  // plus signs (for legacy "Etc/GMT+1").
  return /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz);
}
