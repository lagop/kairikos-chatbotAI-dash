import 'server-only';

// =============================================================================
// WP-26 — one entry point for logging a caught error with structured
// context, instead of the ad-hoc `console.error('[scope] message:', err)`
// calls scattered across the fragile paths the WP-01/WP-04 audit flagged
// (dashboard session resolution, the Stripe webhook handler, the
// state-transition route). None of those were silent by omission — they
// all had a console.error — but the format was free text per call site,
// which means "find every place clientId=X had a server error today" was
// a grep over prose, not a structured query. This is that one format.
//
// Not a new observability vendor: still just console.error/console.warn
// under the hood (Vercel already ships stdout to its own log pipeline),
// just JSON instead of a hand-written string.
// =============================================================================

export type LogSeverity = 'warn' | 'error';

export interface LogErrorContext {
  /** ChatbotClient.id, when the failure is scoped to one client. */
  clientId?: string | null;
  /** Contact email, when known — helps a human find the client in the admin UI without a second lookup. */
  clientEmail?: string | null;
  /** Which product/surface this belongs to, once Fase 3 has more than one. Defaults to 'chatbot' implicitly by omission today. */
  product?: string;
  /** The route or page this occurred in, e.g. '/portal/dashboard', 'POST /api/stripe/webhook'. */
  route?: string;
  /** Any other structured detail worth keeping — Stripe event id, execution id, etc. */
  [key: string]: unknown;
}

/**
 * Logs a caught error (or a non-fatal anomaly) with structured, greppable
 * context. Never throws, and never sends anything over the network —
 * callers on a flow that also needs to alert a human do that separately
 * (see `notifyOperatorOfExecutionFailure` in operator-notify.ts); this
 * function's only job is to make sure the failure is never invisible in
 * the logs.
 *
 * @param scope    Short dotted identifier for where this happened, e.g.
 *                 'dashboard.session_resolve', 'stripe.webhook',
 *                 'internal.state_transition'. Keep it stable across
 *                 calls at the same site so log queries can filter on it.
 * @param err      The caught value. Doesn't have to be an Error — a lot
 *                 of the call sites this replaces caught non-Error
 *                 throwables (Prisma sometimes throws plain objects).
 * @param context  Structured detail. See LogErrorContext.
 * @param severity 'error' (default) for a failure that broke the primary
 *                 flow; 'warn' for a degraded-but-handled path (e.g. a
 *                 fallback fired and it worked).
 */
export function logError(
  scope: string,
  err: unknown,
  context: LogErrorContext = {},
  severity: LogSeverity = 'error',
): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const entry = {
    level: severity,
    scope,
    message,
    ...context,
    stack,
    timestamp: new Date().toISOString(),
  };
  const line = JSON.stringify(entry);
  if (severity === 'warn') {
    console.warn(line);
  } else {
    console.error(line);
  }
}
