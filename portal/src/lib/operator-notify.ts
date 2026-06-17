// =============================================================================
// KAIA-1061 — operator smart notifications: Resend client + templates.
//
// Owns the Resend SDK wrapper used by POST /api/internal/notify-operator
// and the three notification templates (stuck / execution-failed /
// escalation). The route handler does not call the Resend SDK directly —
// it goes through `sendOperatorNotification` so:
//
//   * The SDK is loaded behind a runtime `require` (see the comment in
//     auth-email.ts) so the Edge runtime bundle does not have to resolve
//     the optional `@react-email/render` peer.
//   * Templates live next to the SDK call, not inlined in the route —
//     makes the next template change a one-file edit.
//   * `null`-safe defaults: the route must not crash if `RESEND_API_KEY`
//     is unset in dev; it logs and returns a typed "skipped" result.
//
// The operator's `Kairikos Ops` from-address is overridable via
// `OPERATOR_NOTIFY_FROM`. In dev with no Resend key, the helper returns
// `{ ok: true, skipped: true, messageId: null }` so the route can still
// persist the dedup row (the operator would otherwise get a flood of
// duplicate alerts when the local dev loop re-fires the same trigger).
// =============================================================================

import 'server-only';

const FROM_ADDRESS =
  process.env.OPERATOR_NOTIFY_FROM ??
  process.env.AUTH_EMAIL_FROM ??
  'Kairikos Ops <ops@kairikos.com>';

// KAIA-1177 (KAIA-1172 / AU-2): the two review-overdue kinds extend the
// original three. They share the same Resend dispatch path and the same
// (clientId, kind, day) dedup but render a different template and add the
// CEO email to the recipient list at escalation severity.
export type NotificationKind =
  | 'stuck'
  | 'execution-failed'
  | 'escalation'
  | 'review-overdue-warning'
  | 'review-overdue-escalation';

export const ALLOWED_KINDS: ReadonlySet<NotificationKind> = new Set([
  'stuck',
  'execution-failed',
  'escalation',
  'review-overdue-warning',
  'review-overdue-escalation',
]);

// Severity → NotificationKind. Used by review-overdue/fire so the route
// can pass the kind as a string for dedup without carrying the
// 'review-overdue-' prefix through the request body.
export type ReviewOverdueSeverity = 'warning' | 'escalation';
export function reviewOverdueKind(severity: ReviewOverdueSeverity): NotificationKind {
  return severity === 'escalation'
    ? 'review-overdue-escalation'
    : 'review-overdue-warning';
}

export interface OperatorRecipient {
  email: string;
  // Resolved client display name for template personalization. Optional —
  // the route falls back to the clientId when missing.
  clientName?: string | null;
}

export interface SendOperatorNotificationInput {
  kind: NotificationKind;
  to: OperatorRecipient[];
  subject: string;
  text: string;
  html: string;
}

export type SendOperatorNotificationResult =
  | { ok: true; messageId: string }
  | { ok: true; skipped: true; messageId: null; reason: 'no_api_key' | 'no_recipients' }
  | { ok: false; error: string };

/**
 * Send an email to the operator recipients via Resend. Returns a typed
 * result so the caller can persist the right `resendMessageId` and
 * `OperatorNotification` row.
 *
 * The function never throws — Resend errors are mapped to
 * `{ ok: false, error }` so the route can decide whether to alert.
 */
export async function sendOperatorNotification(
  input: SendOperatorNotificationInput,
): Promise<SendOperatorNotificationResult> {
  if (input.to.length === 0) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_recipients' };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Dev path. The route still dedupes and persists a row, but the
    // Resend message id is null.
    return { ok: true, skipped: true, messageId: null, reason: 'no_api_key' };
  }

  // Same dynamic-require trick as auth-email.ts to keep the SDK out of
  // the Edge bundle. Webpack's static analyser can't follow the computed
  // specifier, so it leaves the import as a runtime resolution.
  const requireResend = (0, eval)('require') as NodeJS.Require;
  const { Resend } = requireResend('resend') as typeof import('resend');
  const resend = new Resend(apiKey);

  try {
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: input.to.map((r) => r.email),
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    const messageId = result.data?.id ?? null;
    return { ok: true, messageId: messageId ?? 'unknown' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, error: message };
  }
}

// =============================================================================
// Templates
// =============================================================================

export interface StuckContext {
  clientId: string;
  clientName: string;
  milestone: string; // e.g. "T+3"
  hoursSince: number;
  portalUrl?: string;
}

export interface ExecutionFailedContext {
  clientId?: string | null;
  clientName?: string | null;
  executionId: string;
  workflowName: string;
  error: string;
  portalUrl?: string;
}

export interface EscalationContext {
  clientId: string;
  clientName: string;
  reason: string;
  status?: string | null;
  portalUrl?: string;
}

// KAIA-1177 (KAIA-1172 / AU-2) — review-overdue notification context.
// The wizard step sits in `submitted` (or `needs_revision` with a client
// response) past the 24h hábiles SLA. `businessHoursElapsed` is the
// authoritative number — the route computed it server-side in the
// operator's timezone so the operator sees the same figure here that
// the scan route returned. `ceoCopied` is true when this notification
// was also sent to the CEO (escalation severity only).
export interface ReviewOverdueContext {
  clientId: string;
  clientName: string;
  stepKey: string;
  stepVersion: number;
  stepStatus: string;
  businessHoursElapsed: number;
  severity: ReviewOverdueSeverity;
  ceoCopied: boolean;
  portalUrl?: string;
}

const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function portalLink(href: string | undefined, label: string): string {
  const url = escapeHtml(href ?? `${PORTAL_BASE_URL}/admin/operator`);
  return `<a href="${url}" style="color: #111827;">${escapeHtml(label)}</a>`;
}

function renderShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="es">
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
    <div style="border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; margin-bottom: 20px;">
      <p style="margin: 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7280;">Kairikos Ops</p>
      <h1 style="margin: 4px 0 0; font-size: 20px;">${escapeHtml(title)}</h1>
    </div>
    ${bodyHtml}
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 28px 0;" />
    <p style="font-size: 12px; color: #6b7280;">
      Esta alerta la envía el portal automáticamente. Solo recibirás otra si la situación cambia o si vuelven a pasar 24h.
    </p>
  </body>
</html>`;
}

// ----- stuck ----------------------------------------------------------------

export function renderStuck(ctx: StuckContext): { subject: string; text: string; html: string } {
  const subject = `[Kairikos] Cliente atascado: ${ctx.clientName} (${ctx.milestone}, ${ctx.hoursSince}h)`;
  const text = [
    'Hola,',
    '',
    `El cliente "${ctx.clientName}" (${ctx.clientId}) lleva ${ctx.hoursSince} horas sin actividad en el milestone ${ctx.milestone}.`,
    '',
    'Acción: revisa el portal y contacta al cliente si lleva más de 24h.',
    `Portal: ${ctx.portalUrl ?? `${PORTAL_BASE_URL}/admin/operator`}`,
    '',
    '— Kairikos Ops',
  ].join('\n');
  const html = renderShell(
    'Cliente atascado',
    `<p>El cliente <strong>${escapeHtml(ctx.clientName)}</strong> (${escapeHtml(ctx.clientId)}) lleva <strong>${ctx.hoursSince} horas</strong> sin actividad en el milestone <strong>${escapeHtml(ctx.milestone)}</strong>.</p>
     <p style="margin: 24px 0;">${portalLink(ctx.portalUrl, 'Abrir en el portal')}</p>`,
  );
  return { subject, text, html };
}

// ----- execution-failed -----------------------------------------------------

export function renderExecutionFailed(
  ctx: ExecutionFailedContext,
): { subject: string; text: string; html: string } {
  const subject = `[Kairikos] Fallo de ejecución: ${ctx.workflowName}${ctx.clientName ? ` (${ctx.clientName})` : ''}`;
  const text = [
    'Hola,',
    '',
    `La ejecución ${ctx.executionId} del workflow "${ctx.workflowName}" ha fallado.`,
    ctx.clientName ? `Cliente: ${ctx.clientName} (${ctx.clientId ?? 'sin asignar'})` : 'Cliente: sin asignar',
    `Error: ${ctx.error}`,
    '',
    'Acción: revisa los logs de n8n y reintenta si procede.',
    `Portal: ${ctx.portalUrl ?? `${PORTAL_BASE_URL}/admin/operator`}`,
    '',
    '— Kairikos Ops',
  ].join('\n');
  const clientLine = ctx.clientName
    ? `<p>Cliente: <strong>${escapeHtml(ctx.clientName)}</strong> (${escapeHtml(ctx.clientId ?? 'sin asignar')})</p>`
    : '<p>Cliente: <em>sin asignar</em></p>';
  const html = renderShell(
    'Fallo de ejecución n8n',
    `<p>La ejecución <code>${escapeHtml(ctx.executionId)}</code> del workflow <strong>${escapeHtml(ctx.workflowName)}</strong> ha fallado.</p>
     ${clientLine}
     <pre style="background: #f3f4f6; padding: 12px; border-radius: 6px; font-size: 13px; overflow: auto; white-space: pre-wrap; word-break: break-word;">${escapeHtml(ctx.error)}</pre>
     <p style="margin: 24px 0;">${portalLink(ctx.portalUrl, 'Abrir en el portal')}</p>`,
  );
  return { subject, text, html };
}

// ----- escalation -----------------------------------------------------------

export function renderEscalation(
  ctx: EscalationContext,
): { subject: string; text: string; html: string } {
  const subject = `[Kairikos] Escalado a CEO: ${ctx.clientName}`;
  const text = [
    'Hola,',
    '',
    `El cliente "${ctx.clientName}" (${ctx.clientId}) necesita escalado al CEO.`,
    ctx.status ? `Estado actual: ${ctx.status}` : null,
    `Motivo: ${ctx.reason}`,
    '',
    'Acción: pasa el caso al CEO en el próximo standup.',
    `Portal: ${ctx.portalUrl ?? `${PORTAL_BASE_URL}/admin/operator`}`,
    '',
    '— Kairikos Ops',
  ]
    .filter((line) => line !== null)
    .join('\n');
  const statusLine = ctx.status
    ? `<p>Estado actual: <strong>${escapeHtml(ctx.status)}</strong></p>`
    : '';
  const html = renderShell(
    'Escalado al CEO',
    `<p>El cliente <strong>${escapeHtml(ctx.clientName)}</strong> (${escapeHtml(ctx.clientId)}) necesita escalado al CEO.</p>
     ${statusLine}
     <p>Motivo: ${escapeHtml(ctx.reason)}</p>
     <p style="margin: 24px 0;">${portalLink(ctx.portalUrl, 'Abrir en el portal')}</p>`,
  );
  return { subject, text, html };
}

// ----- review-overdue --------------------------------------------------------
// KAIA-1177 (KAIA-1172 / AU-2). Warning renders when the step has been
// waiting 24–48h hábiles; escalation at >=48h hábiles. The escalation
// subject explicitly tags the CEO so it's distinguishable from the
// regular operator alert in the inbox.
export function renderReviewOverdue(
  ctx: ReviewOverdueContext,
): { subject: string; text: string; html: string } {
  const ceoTag = ctx.ceoCopied ? ' [CEO]' : '';
  const subject = `[Kairikos]${ceoTag} Review-overdue: ${ctx.clientName} — Paso ${ctx.stepKey} (${ctx.businessHoursElapsed.toFixed(1)}h hábiles)`;
  const hours = ctx.businessHoursElapsed.toFixed(1);
  const action = ctx.severity === 'escalation'
    ? 'El paso lleva más de 48h hábiles esperando — escala al CEO en el próximo standup.'
    : 'El paso lleva más de 24h hábiles esperando revisión.';
  const text = [
    'Hola,',
    '',
    `El cliente "${ctx.clientName}" (${ctx.clientId}) tiene el Paso ${ctx.stepKey} (versión ${ctx.stepVersion}, estado "${ctx.stepStatus}") esperando revisión.`,
    `Horas hábiles transcurridas: ${hours} (severidad: ${ctx.severity}).`,
    '',
    action,
    ctx.ceoCopied ? 'Esta alerta también se ha enviado al CEO.' : null,
    `Portal: ${ctx.portalUrl ?? `${PORTAL_BASE_URL}/admin/operator`}`,
    '',
    '— Kairikos Ops',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  const ceoLine = ctx.ceoCopied
    ? '<p style="color: #b91c1c;"><strong>Esta alerta también se ha enviado al CEO.</strong></p>'
    : '';
  const html = renderShell(
    ctx.severity === 'escalation' ? 'Review-overdue (escalado)' : 'Review-overdue',
    `<p>El cliente <strong>${escapeHtml(ctx.clientName)}</strong> (${escapeHtml(ctx.clientId)}) tiene el <strong>Paso ${escapeHtml(ctx.stepKey)}</strong> (versión ${ctx.stepVersion}, estado <code>${escapeHtml(ctx.stepStatus)}</code>) esperando revisión.</p>
     <p>Horas hábiles transcurridas: <strong>${hours}</strong> (severidad: <strong>${escapeHtml(ctx.severity)}</strong>).</p>
     ${ceoLine}
     <p style="margin: 24px 0;">${portalLink(ctx.portalUrl, 'Abrir en el portal')}</p>`,
  );
  return { subject, text, html };
}

// =============================================================================
// Allowlist + recipient helpers
// =============================================================================

/**
 * Parses `KAIRIKOS_NOTIFY_KINDS` (a comma-separated allowlist) into a Set.
 * Returns `null` when the env var is unset — the caller should treat that
 * as "all kinds allowed". An empty string after trimming is treated the
 * same as unset so dev with `KAIRIKOS_NOTIFY_KINDS=` doesn't silently
 * silence every alert.
 */
export function parseKindsAllowlist(
  raw: string | undefined,
): ReadonlySet<NotificationKind> | null {
  if (!raw) return null;
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0) as NotificationKind[];
  if (tokens.length === 0) return null;
  const filtered = tokens.filter((k) => ALLOWED_KINDS.has(k));
  if (filtered.length === 0) return null;
  return new Set(filtered);
}

/**
 * Resolves the operator recipient list from `KAIRIKOS_OPERATOR_EMAILS`.
 * Empty list → caller decides whether to skip or fail closed. The route
 * fails closed (returns a 5xx) because sending no email when the operator
 * was expecting one is the worse outcome.
 */
export function resolveOperatorRecipients(
  raw: string | undefined,
): OperatorRecipient[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((email) => ({ email }));
}

/**
 * Returns the current UTC date in YYYY-MM-DD form. Used as the `day`
 * column in `OperatorNotification` so the unique constraint is stable
 * across timezones.
 */
export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// KAIA-1177 (KAIA-1172 / AU-2): the review-overdue/fire route adds the
// CEO email to the recipient list at escalation severity. The CEO email
// is a single address (no list) and is sourced from `KAIRIKOS_CEO_EMAIL`.
// Empty / unset → caller fails closed (500 `ceo_not_configured`) so the
// operator immediately sees the missing-config issue in the same alert
// cycle, not silently 4 hours later when they wonder why the CEO never
// replied.
export function resolveCeoRecipient(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
