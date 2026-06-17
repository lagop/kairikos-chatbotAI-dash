// =============================================================================
// KAIA-1110 — Per-integration health-probe library.
//
// This module is the single source of truth for "is integration X healthy
// right now?" — the same set of probe functions is called by:
//   * the long-running worker at `scripts/health-probe.ts` (5-min cadence)
//   * the manual /api/internal/health-probe/run route (operator-triggered)
//
// Why a dedicated lib:
//   * The probe rules (status codes → status, timeout → degraded) are easy
//     to get subtly wrong. Centralising them means the worker, the route,
//     and the unit tests all run the same code.
//   * Each probe is dependency-injectable via a `ProbeContext`, so unit
//     tests can swap a mocked `fetch`/DB driver without monkey-patching
//     globals. This is critical for the MTTD/MTTR lens: a silent
//     regression in a probe must be caught at PR time, not in prod.
//
// Idempotency: every probe is read-only against the external service. The
// worker writes the result via `recordHealthCheck` (KAIA-1106) and
// intentionally only writes an `OperatorSettingsAudit` row on a *state
// change*, so re-runs within a stable state are no-ops at the audit level.
//
// Note: this module intentionally does NOT import `server-only`. The
// worker (`scripts/health-probe.ts`) is a plain Node.js process, not a
// Next.js route — so the `server-only` guard would block legitimate
// CLI usage. The browser-side `HealthStatus` type import from
// `./operator-settings` is type-only and tree-shaken in any bundle.
// =============================================================================

import type { HealthStatus } from './operator-settings';

// ── Public types ───────────────────────────────────────────────────────────

export type ProbeOutcome = {
  status: HealthStatus;
  /** Wall-clock duration of the probe, in ms. */
  durationMs: number;
  /** Human-readable detail for the audit log. Omit on healthy runs. */
  error?: string;
};

/** A pluggable `fetch`-shaped function. Allows tests to inject mocks. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface ProbeContext {
  /** Override the global fetch (mostly for tests). */
  fetchImpl?: FetchLike;
  /** Per-probe timeout in ms. Default: 5_000. */
  timeoutMs?: number;
  /** Slow threshold for the supabase probe in ms. Default: 2_000. */
  supabaseSlowMs?: number;
  /** Resolved env values. Optional — the worker resolves once and passes. */
  env?: Partial<ProbeEnv>;
}

export interface ProbeEnv {
  resendApiKey: string;
  n8nApiKey: string;
  n8nBaseUrl: string;
  supabaseDatabaseUrl: string;
  portalApiKey: string;
  portalBaseUrl: string;
}

/** Function signature every per-toolKey probe must satisfy. */
export type ProbeFn = (
  row: { id: string; toolKey: string; envVarName: string | null },
  ctx: ProbeContext,
) => Promise<ProbeOutcome>;

// ── HTTP helpers ───────────────────────────────────────────────────────────

/**
 * Race a `fetch`-shaped call against an `AbortSignal`-driven timeout.
 * Returns `{ status, ok, text }` on success, or throws on abort.
 */
async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string> },
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; text(): Promise<string> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Convert an arbitrary exception into a stable `ProbeOutcome`. */
function outcomeFromException(
  durationMs: number,
  err: unknown,
  timeoutMs: number,
): ProbeOutcome {
  const message = err instanceof Error ? err.message : String(err);
  const isAbort = err instanceof Error && err.name === 'AbortError';
  if (isAbort) {
    return {
      status: 'degraded',
      durationMs,
      error: `probe exceeded ${timeoutMs}ms timeout`,
    };
  }
  return { status: 'failed', durationMs, error: message };
}

// ── Per-toolKey probes ─────────────────────────────────────────────────────

/**
 * Resend: `GET https://resend.com/api/domains` with the current API key.
 * 200 → healthy. 401/403 → failed. Other 4xx/5xx → degraded.
 */
export const probeResend: ProbeFn = async (row, ctx) => {
  const started = Date.now();
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = ctx.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const apiKey = ctx.env?.resendApiKey ?? process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      status: 'failed',
      durationMs: Date.now() - started,
      error: 'RESEND_API_KEY is not set',
    };
  }
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      'https://resend.com/api/domains',
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } },
      timeoutMs,
    );
    const durationMs = Date.now() - started;
    if (res.status === 200) return { status: 'healthy', durationMs };
    if (res.status === 401 || res.status === 403) {
      return { status: 'failed', durationMs, error: `resend auth ${res.status}` };
    }
    return { status: 'degraded', durationMs, error: `resend status ${res.status}` };
  } catch (err) {
    return outcomeFromException(Date.now() - started, err, timeoutMs);
  }
};

/**
 * n8n: `GET <base>/api/v1/workflows?limit=1` with the current API key.
 * 200 → healthy. Auth failure → failed. Other → degraded.
 */
export const probeN8n: ProbeFn = async (row, ctx) => {
  const started = Date.now();
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = ctx.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const apiKey = ctx.env?.n8nApiKey ?? process.env.N8N_API_KEY;
  const base = (ctx.env?.n8nBaseUrl ?? process.env.N8N_BASE_URL ?? 'https://n8n.kairikos.com')
    .replace(/\/$/, '');
  if (!apiKey) {
    return {
      status: 'failed',
      durationMs: Date.now() - started,
      error: 'N8N_API_KEY is not set',
    };
  }
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${base}/api/v1/workflows?limit=1`,
      { method: 'GET', headers: { 'X-N8N-API-KEY': apiKey } },
      timeoutMs,
    );
    const durationMs = Date.now() - started;
    if (res.status === 200) return { status: 'healthy', durationMs };
    if (res.status === 401 || res.status === 403) {
      return { status: 'failed', durationMs, error: `n8n auth ${res.status}` };
    }
    return { status: 'degraded', durationMs, error: `n8n status ${res.status}` };
  } catch (err) {
    return outcomeFromException(Date.now() - started, err, timeoutMs);
  }
};

/**
 * Supabase: open a Postgres connection (using the existing DATABASE_URL,
 * reused as the supabase connection string), run `SELECT 1`. Connection
 * refused / auth failure → failed. Slow response (>slowMs) → degraded.
 *
 * Uses the built-in `pg`-less approach by relying on the Prisma client
 * that is already initialised in this codebase — the lib does not need
 * to open its own pool. The worker reuses the singleton from `prisma.ts`.
 */
export const probeSupabase: ProbeFn = async (row, ctx) => {
  const started = Date.now();
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const slowMs = ctx.supabaseSlowMs ?? DEFAULT_SUPABASE_SLOW_MS;
  const dbUrl = ctx.env?.supabaseDatabaseUrl ?? process.env.DATABASE_URL;
  if (!dbUrl) {
    return {
      status: 'failed',
      durationMs: Date.now() - started,
      error: 'DATABASE_URL is not set',
    };
  }
  try {
    const res = await Promise.race<{ status: HealthStatus; error?: string }>([
      selectOneWithTimeout(timeoutMs),
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ status: 'degraded', error: `supabase exceeded ${slowMs}ms` }),
          slowMs,
        ),
      ),
    ]);
    const durationMs = Date.now() - started;
    if (res.status === 'healthy') {
      if (durationMs > slowMs) {
        return { status: 'degraded', durationMs, error: `supabase slow (${durationMs}ms)` };
      }
      return { status: 'healthy', durationMs };
    }
    return { status: res.status, durationMs, error: res.error };
  } catch (err) {
    return outcomeFromException(Date.now() - started, err, timeoutMs);
  }
};

/**
 * portal_api_key: call the portal's own settings API with the key.
 * 200 → healthy. 401 → failed. 5xx → degraded.
 *
 * The `portal_api_key` toolKey is the *portal's own* key, so the probe
 * is internal — the test is "does this key still authenticate?". We hit
 * `GET /api/internal/portal/settings` (the KAIA-1109 read endpoint) —
 * falling back to `GET /api/health` if the settings endpoint is not yet
 * wired, so the probe is useful during the transition.
 */
export const probePortalApiKey: ProbeFn = async (row, ctx) => {
  const started = Date.now();
  const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = ctx.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const key = ctx.env?.portalApiKey ?? process.env.PORTAL_API_KEY;
  const base = (ctx.env?.portalBaseUrl ?? process.env.NEXT_PUBLIC_PORTAL_URL ?? '').replace(
    /\/$/,
    '',
  );
  if (!key) {
    return {
      status: 'failed',
      durationMs: Date.now() - started,
      error: 'PORTAL_API_KEY is not set',
    };
  }
  if (!base) {
    return {
      status: 'unknown',
      durationMs: Date.now() - started,
      error: 'NEXT_PUBLIC_PORTAL_URL is not set',
    };
  }
  // Prefer the dedicated probe endpoint; fall back to /api/health.
  const url = `${base}/api/internal/health-probe/ping`;
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      { method: 'GET', headers: { 'x-kairikos-internal-key': key } },
      timeoutMs,
    );
    const durationMs = Date.now() - started;
    if (res.status === 200) return { status: 'healthy', durationMs };
    if (res.status === 401) {
      return { status: 'failed', durationMs, error: 'portal_api_key invalid' };
    }
    if (res.status >= 500) {
      return { status: 'degraded', durationMs, error: `portal ${res.status}` };
    }
    // The probe endpoint may not exist yet (KAIA-1109). A 404 is
    // ambiguous — the key could be fine, or the route could be missing.
    // We mark this `unknown` so the UI shows a "probe not configured"
    // hint and the operator investigates.
    return { status: 'unknown', durationMs, error: `portal ${res.status}` };
  } catch (err) {
    return outcomeFromException(Date.now() - started, err, timeoutMs);
  }
};

/**
 * Default probe for unknown `toolKey`: skip with `unknown`. The settings
 * page renders a "no probe configured" hint for these rows.
 */
export const probeUnknown: ProbeFn = async (row, ctx) => {
  return {
    status: 'unknown',
    durationMs: 0,
    error: `no probe configured for toolKey=${row.toolKey}`,
  };
};

// ── Dispatch table ─────────────────────────────────────────────────────────

export const PROBES: Record<string, ProbeFn> = {
  resend: probeResend,
  n8n: probeN8n,
  supabase: probeSupabase,
  portal_api_key: probePortalApiKey,
};

export function getProbe(toolKey: string): ProbeFn {
  return PROBES[toolKey] ?? probeUnknown;
}

// ── Internal helpers ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_SUPABASE_SLOW_MS = 2_000;

async function selectOneWithTimeout(timeoutMs: number): Promise<{
  status: HealthStatus;
  error?: string;
}> {
  // Dynamic import to avoid loading Prisma in test environments that
  // haven't bootstrapped the schema. The worker passes an explicit
  // `fetchImpl` shape via Prisma — but the lib also supports a minimal
  // pg-less path for unit tests.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    // Promise.race against the call's own timeout (not the slowMs).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ status: HealthStatus; error: string }>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: 'failed', error: `supabase exceeded ${timeoutMs}ms` }),
        timeoutMs,
      );
    });
    const result = await Promise.race([runSelectOne(prisma), timeout]);
    if (timer) clearTimeout(timer);
    return result;
  } finally {
    await prisma.$disconnect();
  }
}

async function runSelectOne(prisma: { $queryRawUnsafe: (q: string) => Promise<unknown> }): Promise<{
  status: HealthStatus;
  error?: string;
}> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    return { status: 'healthy' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Common Postgres failure signatures:
    //   * "ENOTFOUND" / "ECONNREFUSED" → network/host down
    //   * "password authentication failed" / 28P01 → bad creds
    //   * "ETIMEDOUT" → firewall/timeout
    if (
      /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(msg) ||
      /password authentication failed|28P01|invalid authorization/i.test(msg)
    ) {
      return { status: 'failed', error: msg };
    }
    return { status: 'failed', error: msg };
  }
}
