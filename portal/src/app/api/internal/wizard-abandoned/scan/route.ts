import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import {
  authenticateInternalRequest,
  internalAuthFailureResponse,
} from '@/lib/internal-auth';

// =============================================================================
// POST /api/internal/wizard-abandoned/scan
//
// KAIA-1177 (KAIA-1172 / AU-2) — read-only scan route the n8n
// `wizard-abandoned` flow calls every 6 hours. Returns the set of
// clients that look abandoned: the most recent `ChatbotConfigStep` write
// with `status='draft'` is > 48h old AND the client has no submission
// after that latest draft AND the client is still in the wizard
// (i.e. the client is mid-configuration, not live, paused, or
// cancelled). The response also projects `alreadyFiredInWindow: boolean`
// from a `ChatbotActivity` row with `milestone='wizard_abandoned'` in
// the last 7 days, so the n8n loop can skip duplicates cheaply.
//
// Auth: shared secret via `PORTAL_API_KEY`, verified by
// `authenticateInternalRequest`. Fail closed if the env var is unset.
//
// The route is idempotent — it never writes. It just runs the SQL
// from the runbook §3.1 in raw form so the planner can use the
// `chatbot_wizard_step_data` and `chatbot_activity` indexes we already
// have on (client_id, status) and (client_id, occurred_at).
//
// KAIA-1177 note on state values: the runbook §3.1 SQL uses
// `state = 'configuring'`, which is the wizard team's pre-v1 vocabulary.
// The current Prisma column (KAIA-1062) ships with allowed values
// 'in-progress' | 'go-live-pending' | 'live' (server-enforced). The
// scan uses `state IN ('in-progress', 'go-live-pending')` to match the
// spirit of the runbook's "still in the wizard" check, since
// `go-live-pending` is the client-requested handoff and `live`/`paused`
///`cancelled` are the post-wizard states. The companion ticket against
// KAIA-731 plans to add `'configuring'` to the allowlist and re-tag the
// v1 wizard clients — that alignment is tracked in the runbook and
// does not block this route from shipping.
// =============================================================================

const WIZARD_ABANDONED_WINDOW_HOURS = 48;
const WIZARD_ABANDONED_DEDUP_DAYS = 7;

interface ScanCandidate {
  clientId: string;
  companyName: string;
  contactEmail: string;
  contactName: string;
  vertical: string | null;
  tier: string;
  lastDraftAt: string;
  lastSubmittedAt: string | null;
  lastStepKey: string;
  hoursSinceLastDraft: number;
  alreadyFiredInWindow: boolean;
}

interface ScanRow {
  clientId: string;
  companyName: string;
  contactEmail: string;
  contactName: string;
  vertical: string | null;
  tier: string;
  lastDraftAt: Date;
  lastSubmittedAt: Date | null;
  lastStepKey: string;
  hoursSinceLastDraft: number;
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

  // The route is read-only and the body is unused, but we still parse
  // it so a stray `{}` from n8n doesn't fail JSON parse and so future
  // optional params (e.g. `limit`, dry-run flags) can ride along.
  let body: unknown = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be valid JSON' },
      { status: 400 },
    );
  }
  if (body !== null && typeof body !== 'object') {
    return NextResponse.json(
      { error: 'bad_request', detail: 'body must be a JSON object' },
      { status: 400 },
    );
  }

  try {
    const rows = await scanWizardAbandoned();
    const candidates: ScanCandidate[] = rows.map((row) => ({
      clientId: row.clientId,
      companyName: row.companyName,
      contactEmail: row.contactEmail,
      contactName: row.contactName,
      vertical: row.vertical,
      tier: row.tier,
      lastDraftAt: row.lastDraftAt.toISOString(),
      lastSubmittedAt: row.lastSubmittedAt ? row.lastSubmittedAt.toISOString() : null,
      lastStepKey: row.lastStepKey,
      hoursSinceLastDraft: Math.round(row.hoursSinceLastDraft * 100) / 100,
      alreadyFiredInWindow: row.alreadyFiredInWindow,
    }));
    return NextResponse.json({
      ok: true,
      windowHours: WIZARD_ABANDONED_WINDOW_HOURS,
      now: new Date().toISOString(),
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
 * Run the wizard-abandoned scan. Exported (named) so the smoke test
 * (scripts/smoke-wizard-abandoned.ts) can reuse the in-memory logic
 * without going through Prisma.
 *
 * The SQL mirrors the runbook §3.1 contract:
 *
 *   1. Pick every client whose global state is still "in the wizard"
 *      (in-progress | go-live-pending — see the state-values note in
 *      the route docstring).
 *   2. For each such client, find the timestamp of the most recent
 *      `ChatbotConfigStep` write with `status='draft'`. That's the
 *      "last draft" the n8n flow reports.
 *   3. Filter to clients whose most recent draft is > 48h old AND
 *      who have no submission that came after the latest draft
 *      (so the client is genuinely stuck, not "submitted, then went
 *      quiet" — that would be review-overdue's job).
 *   4. Project `alreadyFiredInWindow` from a `ChatbotActivity` row
 *      with `milestone='wizard_abandoned'` in the last 7 days.
 */
async function scanWizardAbandoned(): Promise<ScanRow[]> {
  // Use Prisma's $queryRaw with tagged template for parameterization.
  // The window/dedup are constants in the route (not env-driven) so we
  // interpolate the interval directly.
  const windowHours = WIZARD_ABANDONED_WINDOW_HOURS;
  const dedupDays = WIZARD_ABANDONED_DEDUP_DAYS;

  const rows = await prisma.$queryRaw<RawScanRow[]>(Prisma.sql`
    WITH configuring_clients AS (
      SELECT
        c.id            AS "clientId",
        c."companyName" AS "companyName",
        c.email         AS "contactEmail",
        c.name          AS "contactName",
        c.vertical      AS "vertical",
        c.tier          AS "tier"
      FROM "ChatbotClient" c
      WHERE c.state IN ('in-progress', 'go-live-pending')
    ),
    last_draft AS (
      SELECT
        s."clientId" AS client_id,
        MAX(s."updatedAt") AS last_draft_at,
        (array_agg(s."stepKey" ORDER BY s."updatedAt" DESC))[1] AS last_step_key
      FROM "ChatbotConfigStep" s
      WHERE s.status = 'draft'
      GROUP BY s."clientId"
    ),
    last_submit AS (
      SELECT
        s."clientId" AS client_id,
        MAX(s."submittedAt") AS last_submitted_at
      FROM "ChatbotConfigStep" s
      WHERE s."submittedAt" IS NOT NULL
      GROUP BY s."clientId"
    )
    SELECT
      c."clientId"::text                    AS "clientId",
      c."companyName"                       AS "companyName",
      c."contactEmail"                      AS "contactEmail",
      c."contactName"                       AS "contactName",
      c."vertical"                          AS "vertical",
      c."tier"                              AS "tier",
      ld.last_draft_at                      AS "lastDraftAt",
      ls.last_submitted_at                  AS "lastSubmittedAt",
      ld.last_step_key                      AS "lastStepKey",
      EXTRACT(EPOCH FROM (now() - ld.last_draft_at)) / 3600.0
                                            AS "hoursSinceLastDraft",
      EXISTS (
        SELECT 1 FROM "ChatbotActivity" a
        WHERE a."clientId" = c."clientId"
          AND a.milestone = 'wizard_abandoned'
          AND a."completedAt" > now() - (${dedupDays}::text || ' days')::interval
      ) AS "alreadyFiredInWindow"
    FROM configuring_clients c
    JOIN last_draft ld ON ld.client_id = c."clientId"
    LEFT JOIN last_submit ls ON ls.client_id = c."clientId"
    WHERE
      ld.last_draft_at < now() - (${windowHours}::text || ' hours')::interval
      AND (ls.last_submitted_at IS NULL OR ls.last_submitted_at < ld.last_draft_at)
    ORDER BY ld.last_draft_at ASC;
  `);

  return rows.map((row) => ({
    clientId: String(row.clientId),
    companyName: row.companyName,
    contactEmail: row.contactEmail,
    contactName: row.contactName,
    vertical: row.vertical ?? null,
    tier: row.tier,
    lastDraftAt: new Date(row.lastDraftAt),
    lastSubmittedAt: row.lastSubmittedAt ? new Date(row.lastSubmittedAt) : null,
    lastStepKey: row.lastStepKey,
    hoursSinceLastDraft: Number(row.hoursSinceLastDraft),
    alreadyFiredInWindow: Boolean(row.alreadyFiredInWindow),
  }));
}

interface RawScanRow {
  clientId: string;
  companyName: string;
  contactEmail: string;
  contactName: string;
  vertical: string | null;
  tier: string;
  lastDraftAt: Date | string;
  lastSubmittedAt: Date | string | null;
  lastStepKey: string;
  hoursSinceLastDraft: number | string;
  alreadyFiredInWindow: boolean;
}
