import { NextResponse, type NextRequest } from 'next/server';
import { isDatabaseConfigured, prisma } from '@/lib/prisma';
import {
  authenticateInternalRequest,
  internalAuthFailureResponse,
} from '@/lib/internal-auth';
import { getProbe, type ProbeContext } from '@/lib/health-probe';
import { recordHealthCheck } from '@/lib/operator-settings';

// =============================================================================
// GET /api/internal/health-probe/run
//
// KAIA-1110 — operator-triggered "check now" endpoint. Runs the same
// probe pass as the long-running worker (scripts/health-probe.ts) and
// returns the per-toolKey results. Used by the QA smoke and by the
// future "check now" button on the settings page.
//
// Auth: shared secret in PORTAL_API_KEY, same as the other /api/internal/*
// routes. Fail closed if the env var is unset.
//
// Idempotency: each probe is read-only against the external service. The
// DB write is delegated to `recordHealthCheck` (KAIA-1106 helper) which
// is the only writer of OperatorSettingsAudit for health changes — and
// it only writes an audit row on a state change. Repeated calls with
// no state change are effectively a no-op at the audit level.
//
// Response shape:
//   { ok: true, results: [{ toolKey, status, durationMs, error? }] }
// =============================================================================

export async function GET(req: NextRequest) {
  const auth = authenticateInternalRequest(req);
  const authError = internalAuthFailureResponse(auth);
  if (authError) return authError;

  if (!isDatabaseConfigured) {
    return NextResponse.json(
      {
        error: 'database_not_configured',
        detail: 'DATABASE_URL is not set; refusing to run',
      },
      { status: 503 },
    );
  }

  const rows = await prisma.operatorSettings.findMany({
    select: {
      id: true,
      toolKey: true,
      envVarName: true,
      lastHealthStatus: true,
    },
    orderBy: { toolKey: 'asc' },
  });

  const timeoutMs = Number(process.env.HEALTH_PROBE_TIMEOUT_MS ?? 5_000);
  const ctx: ProbeContext = { timeoutMs };

  // Per-toolKey probe in parallel — the row count is small (currently
  // <10), and the per-probe timeout caps the wall-clock cost. We don't
  // need the bounded pool here; the route is invoked manually.
  const probes = await Promise.all(
    rows.map(async (row) => {
      const probe = getProbe(row.toolKey);
      const outcome = await probe(
        { id: row.id, toolKey: row.toolKey, envVarName: row.envVarName },
        ctx,
      );
      const previousStatus = (row.lastHealthStatus ?? null) as
        | 'healthy'
        | 'degraded'
        | 'failed'
        | 'unknown'
        | null;
      const stateChanged = previousStatus !== outcome.status;
      try {
        await recordHealthCheck(
          row.toolKey,
          outcome.status,
          { actorEmail: 'health-probe-route@kairikos.local' },
        );
      } catch (err) {
        // The probe succeeded but the DB write failed. Surface that
        // distinctly so the operator knows the integration is healthy
        // but the audit log might be stale.
        return {
          toolKey: row.toolKey,
          status: outcome.status,
          durationMs: outcome.durationMs,
          error: outcome.error,
          previousStatus,
          stateChanged,
          dbWriteError: err instanceof Error ? err.message : String(err),
        };
      }
      return {
        toolKey: row.toolKey,
        status: outcome.status,
        durationMs: outcome.durationMs,
        error: outcome.error,
        previousStatus,
        stateChanged,
      };
    }),
  );

  return NextResponse.json({ ok: true, results: probes });
}

export function POST() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405 });
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
