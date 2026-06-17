import 'server-only';

// =============================================================================
// KAIA-1177 (KAIA-1172 / AU-2) — wizard recovery email.
//
// Sends the Kira-voice v0 recovery email when a client abandons the wizard
// (configuring client with the most-recent `draft` write > 48h old and
// no submission since). The Copywriter's final pass replaces the
// SUBJECT_PREFIX + BODY_TEXT_PREFIX + BODY_HTML_PREFIX constants below;
// the route contract does not change.
//
// Design parallels `src/lib/operator-notify.ts`:
//   * The SDK is loaded behind a runtime `require` (see the comment in
//     auth-email.ts / operator-notify.ts) so the Edge runtime bundle does
//     not have to resolve the optional `@react-email/render` peer.
//   * `null`-safe defaults: the route must not crash if `RESEND_API_KEY`
//     is unset in dev; it logs and returns a typed "skipped" result so
//     the wizard-abandoned/fire route can still persist the dedup row
//     (the operator would otherwise get a flood of duplicate emails when
//     the local dev loop re-fires the same trigger).
//
// Variables (per the runbook §5):
//   clientFirstName, lastStepKey, lastStepHuman, hoursSinceLastDraft,
//   portalUrl.
// =============================================================================

const FROM_ADDRESS =
  process.env.OPERATOR_NOTIFY_FROM ??
  process.env.AUTH_EMAIL_FROM ??
  'Kairikos Ops <ops@kairikos.com>';

const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';

// KAIA-1177: lastStepKey 1..11 only. Step 12 (Integraciones) is v1.1 and
// is out of scope. The wizard-abandoned/fire route validates the key
// before invoking this module.
export const WIZARD_STEP_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'] as const;
export type WizardStepKey = (typeof WIZARD_STEP_KEYS)[number];

// Human-readable step name. Mirrors the `lastStepHuman` map embedded in
// the n8n `Build Recovery Email Payload` code node; the Backend route is
// the source of truth so a Copywriter swap of the step labels is a
// one-file edit.
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

export function isWizardStepKey(value: string): value is WizardStepKey {
  return (WIZARD_STEP_KEYS as readonly string[]).includes(value);
}

export function lastStepHuman(stepKey: string): string {
  return isWizardStepKey(stepKey) ? STEP_HUMAN[stepKey] : `Paso ${stepKey}`;
}

export interface RecoveryEmailVariables {
  clientFirstName: string;
  lastStepKey: string;
  lastStepHuman: string;
  hoursSinceLastDraft: number;
  portalUrl: string;
}

export interface SendRecoveryEmailInput {
  to: string;
  clientFirstName: string;
  lastStepKey: string;
  hoursSinceLastDraft: number;
  // The resolved `lastStepHuman` — already passed through `lastStepHuman()`
  // by the route. Lets the route own the validation while keeping this
  // module pure.
  lastStepHuman: string;
  // Override portal URL (defaults to NEXT_PUBLIC_PORTAL_URL or
  // https://portal.kairikos.com). Useful for tests and for the future
  // per-client branded portal.
  portalUrl?: string;
}

export type SendRecoveryEmailResult =
  | { ok: true; messageId: string }
  | { ok: true; skipped: true; messageId: null; reason: 'no_api_key' | 'no_recipient' }
  | { ok: false; error: string };

export const RECOVERY_EMAIL_TEMPLATE = 'wizard-recovery-v0';

/**
 * Renders the recovery email payload (subject + text + html) so the
 * wizard-abandoned/fire route can persist the same strings in the
 * `ChatbotActivity.notes` column for traceability and audit.
 */
export function buildRecoveryEmail(
  vars: RecoveryEmailVariables,
): { subject: string; text: string; html: string; template: typeof RECOVERY_EMAIL_TEMPLATE } {
  const subject = 'Hemos parado a medias con tu configuración — ¿sigues por aquí?';
  const portalLink = `${vars.portalUrl}/portal/wizard?step=${encodeURIComponent(vars.lastStepKey)}`;
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
  const html = [
    `<p>Hola ${escapeHtml(vars.clientFirstName)},</p>`,
    `<p>Vimos que empezaste a configurar tu chatbot en Kairikos y que te quedaste en el Paso ${escapeHtml(vars.lastStepKey)} (${escapeHtml(vars.lastStepHuman)}). Llevas ${vars.hoursSinceLastDraft} horas sin tocarlo.</p>`,
    `<p>No te preocupes: tu progreso está guardado. Puedes seguir donde lo dejaste entrando a <a href="${escapeHtml(portalLink)}">${escapeHtml(portalLink)}</a> — tardarás menos de 5 minutos en terminar.</p>`,
    `<p>Si te atascaste en algo o prefieres que te llamemos, responde a este email y un humano del equipo te ayuda.</p>`,
    `<p>— El equipo de Kairikos</p>`,
  ].join('\n');
  return { subject, text, html, template: RECOVERY_EMAIL_TEMPLATE };
}

/**
 * Send the wizard recovery email via Resend. Returns a typed result so
 * the caller can persist the right `resendMessageId` and ChatbotActivity
 * row. The function never throws — Resend errors are mapped to
 * `{ ok: false, error }` so the route can decide whether to alert.
 */
export async function sendRecoveryEmail(
  input: SendRecoveryEmailInput,
): Promise<SendRecoveryEmailResult> {
  if (!input.to || !input.to.includes('@')) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_recipient' };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_api_key' };
  }

  const portalUrl = input.portalUrl ?? PORTAL_BASE_URL;
  const rendered = buildRecoveryEmail({
    clientFirstName: input.clientFirstName,
    lastStepKey: input.lastStepKey,
    lastStepHuman: input.lastStepHuman,
    hoursSinceLastDraft: input.hoursSinceLastDraft,
    portalUrl,
  });

  const requireResend = (0, eval)('require') as NodeJS.Require;
  const { Resend } = requireResend('resend') as typeof import('resend');
  const resend = new Resend(apiKey);

  try {
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: [input.to],
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
