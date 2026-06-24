#!/usr/bin/env node
// =============================================================================
// KAIA-1110 — Per-integration health-probe worker.
//
// Single-purpose, idempotent, and safe to re-trigger:
//   * On startup, runs an immediate probe of every OperatorSettings row.
//   * Every HEALTH_PROBE_INTERVAL_MS (default 5 min) thereafter, repeats.
//   * Each probe runs in parallel, capped at HEALTH_PROBE_CONCURRENCY (4).
//   * Each probe has a HEALTH_PROBE_TIMEOUT_MS (5s) timeout.
//   * On state change (e.g. healthy → failed) we record an audit row.
//
// Usage:
//   npx tsx scripts/health-probe.ts                 # long-running worker
//   npx tsx scripts/health-probe.ts --once          # one-shot, exit after run
//   npx tsx scripts/health-probe.ts --once --json   # one-shot, JSON output
//
// Exit codes:
//   0  — run completed (worker stops on SIGINT/SIGTERM with 0; --once ends 0)
//   1  — fatal: DATABASE_URL missing, prisma unreachable, etc.
//   2  — usage error (bad flags)
//
// Environment:
//   DATABASE_URL                    — required (Prisma)
//   RESEND_API_KEY                  — required for the resend probe
//   N8N_API_KEY                     — required for the n8n probe
//   N8N_BASE_URL                    — optional, default https://n8n.kairikos.com
//   PORTAL_API_KEY                  — required for the portal_api_key probe
//   NEXT_PUBLIC_PORTAL_URL          — required for the portal_api_key probe
//   HEALTH_PROBE_INTERVAL_MS        — optional, default 300_000
//   HEALTH_PROBE_TIMEOUT_MS         — optional, default 5_000
//   HEALTH_PROBE_CONCURRENCY        — optional, default 4
//
// Idempotency:
//   * recordHealthCheck() is the only writer. It only writes an
//     OperatorSettingsAudit row when the new status differs from the
//     previous one (KAIA-1106 helper semantics).
//   * Re-running the worker at any cadence is safe — no duplicate rows,
//     no duplicate emails, no duplicate side effects.
//
// Operational notes:
//   * The worker does NOT call the operator. The settings page surfaces
//     the state and the operator decides whether to act. Alerting is a
//     separate ticket.
//   * If DATABASE_URL is unset the worker exits 1 with a clear message.
//     "Fail closed" matches the rest of the portal's posture.
// =============================================================================

import { prisma } from '../src/lib/prisma';
import {
  getProbe,
  type ProbeContext,
  type ProbeOutcome,
} from '../src/lib/health-probe';
import { recordHealthCheck, type HealthStatus } from '../src/lib/operator-settings';

// ── CLI parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(
    [
      'Usage: npx tsx scripts/health-probe.ts [options]',
      '',
      'Options:',
      '  --once             Run a single probe pass and exit (for QA / smoke).',
      '  --json             With --once, print the results as JSON to stdout.',
      '  -h, --help         Show this help.',
      '',
      'Environment:',
      '  DATABASE_URL, RESEND_API_KEY, N8N_API_KEY, PORTAL_API_KEY, NEXT_PUBLIC_PORTAL_URL',
      '  HEALTH_PROBE_INTERVAL_MS (default 300000), HEALTH_PROBE_TIMEOUT_MS (default 5000),',
      '  HEALTH_PROBE_CONCURRENCY (default 4)',
    ].join('\n'),
  );
  process.exit(0);
}
const ONCE = args.includes('--once');
const JSON_OUT = args.includes('--json');
if (args.filter((a) => !['--once', '--json'].includes(a)).length > 0) {
  console.error(`ERROR: Unknown args: ${args.join(' ')}`);
  process.exit(2);
}

// ── Configuration ──────────────────────────────────────────────────────────

const INTERVAL_MS = Number(process.env.HEALTH_PROBE_INTERVAL_MS ?? 300_000);
const TIMEOUT_MS = Number(process.env.HEALTH_PROBE_TIMEOUT_MS ?? 5_000);
const CONCURRENCY = Number(process.env.HEALTH_PROBE_CONCURRENCY ?? 4);

if (!process.env.DATABASE_URL) {
  console.error('[health-probe] FATAL: DATABASE_URL is not set — refusing to start');
  process.exit(1);
}

// ── Core run loop ──────────────────────────────────────────────────────────

type RunResult = {
  toolKey: string;
  status: HealthStatus;
  durationMs: number;
  error?: string;
  previousStatus: HealthStatus | null;
  stateChanged: boolean;
};

async function runOnce(): Promise<RunResult[]> {
  const rows = await prisma.operatorSettings.findMany({
    select: {
      id: true,
      toolKey: true,
      envVarName: true,
      lastHealthStatus: true,
    },
  });
  if (rows.length === 0) {
    console.log('[health-probe] No OperatorSettings rows found — nothing to probe');
    return [];
  }

  const ctx: ProbeContext = { timeoutMs: TIMEOUT_MS };
  const queue = [...rows];
  const results: RunResult[] = [];
  const poolSize = Math.max(1, Math.min(CONCURRENCY, rows.length));

  // Fixed-size worker pool. Promise.all with the full row list would work
  // too, but a bounded pool avoids hammering the external APIs when the
  // settings table grows past a few dozen rows.
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const row = queue.shift();
      if (!row) return;
      const probe = getProbe(row.toolKey);
      const outcome = await probe(
        { id: row.id, toolKey: row.toolKey, envVarName: row.envVarName },
        ctx,
      );
      const previousStatus = (row.lastHealthStatus ?? null) as HealthStatus | null;
      const stateChanged = previousStatus !== outcome.status;
      results.push({
        toolKey: row.toolKey,
        status: outcome.status,
        durationMs: outcome.durationMs,
        error: outcome.error,
        previousStatus,
        stateChanged,
      });
      try {
        await recordHealthCheck(
          row.toolKey,
          outcome.status,
          { actorEmail: 'health-probe-worker@kairikos.local' },
        );
      } catch (err) {
        // The probe succeeded but the DB write failed — surface that
        // distinctly. The next interval will retry the DB write, and
        // we don't want a transient Prisma error to mask a healthy probe.
        console.error(
          `[health-probe:${row.toolKey}] DB write failed after successful probe: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: poolSize }, worker));
  return results;
}

function logResults(results: RunResult[]): void {
  const changed = results.filter((r) => r.stateChanged);
  const failed = results.filter((r) => r.status === 'failed');
  const degraded = results.filter((r) => r.status === 'degraded');
  for (const r of results) {
    const flag = r.stateChanged ? ' [STATE-CHANGED]' : '';
    const errSuffix = r.error ? ` (${r.error})` : '';
    console.log(
      `[health-probe:${r.toolKey}] ${r.status} in ${r.durationMs}ms${flag}${errSuffix}`,
    );
  }
  if (changed.length > 0) {
    console.log(
      `[health-probe] ${changed.length} row(s) changed state — audit rows written`,
    );
  }
  if (failed.length > 0) {
    console.error(`[health-probe] ${failed.length} row(s) FAILED`);
  }
  if (degraded.length > 0) {
    console.warn(`[health-probe] ${degraded.length} row(s) DEGRADED`);
  }
}

// ── Long-running worker ───────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(
    `[health-probe] starting — interval=${INTERVAL_MS}ms timeout=${TIMEOUT_MS}ms concurrency=${CONCURRENCY}`,
  );

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[health-probe] received ${sig}, shutting down after current pass`);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // Immediate pass on startup so the operator sees fresh data without
  // waiting for the first interval.
  const first = await runOnce();
  logResults(first);

  while (!stopping) {
    await sleep(INTERVAL_MS);
    if (stopping) break;
    try {
      const results = await runOnce();
      logResults(results);
    } catch (err) {
      console.error(
        `[health-probe] run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Do not exit — the worker is resilient. The next tick will retry.
    }
  }
  await prisma.$disconnect();
  console.log('[health-probe] stopped');
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mainOnce(): Promise<void> {
  const results = await runOnce();
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: true, results }, null, 2) + '\n');
  } else {
    logResults(results);
  }
  await prisma.$disconnect();
}

const topLevel = ONCE ? mainOnce() : main();
topLevel.catch(async (err) => {
  console.error(
    `[health-probe] FATAL: ${err instanceof Error ? err.message : String(err)}`,
  );
  await prisma.$disconnect();
  process.exit(1);
});
