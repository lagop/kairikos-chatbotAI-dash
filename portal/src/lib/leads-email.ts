import 'server-only';

// =============================================================================
// Leads Fase 6 — email notification to the client when a NEW lead is
// captured. Calcado del patrón de web-quote-email.ts: dynamic `require`
// for the Resend SDK (keeps it out of the Edge bundle), never throws,
// returns a typed result so the caller logs/ignores the outcome instead
// of failing the ingestion request the email is a side effect of.
//
// Why this exists: leads go cold fast, and until now the client had no
// way to know one had arrived short of opening /portal/leads on their
// own initiative. Only fires on a genuinely NEW lead (POST
// /api/internal/leads' "created" branch) — never on a refresh of an
// existing 'nuevo' lead from a later turn of the same conversation, or
// this would re-notify on every message of an ongoing chat.
// =============================================================================

const FROM_ADDRESS =
  process.env.OPERATOR_NOTIFY_FROM ?? process.env.AUTH_EMAIL_FROM ?? 'Kairikos Ops <ops@kairikos.com>';
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';
const PORTAL_LEADS_URL = `${PORTAL_BASE_URL}/portal/leads`;

const CHANNEL_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  instagram: 'Instagram',
  web: 'tu web',
  phone: 'una llamada',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type SendNewLeadEmailResult =
  | { ok: true; messageId: string }
  | { ok: true; skipped: true; messageId: null; reason: 'no_api_key' | 'no_recipient' }
  | { ok: false; error: string };

async function sendEmail(to: string, rendered: { subject: string; text: string; html: string }): Promise<SendNewLeadEmailResult> {
  if (!to || !to.includes('@')) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_recipient' };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_api_key' };
  }

  const requireResend = (0, eval)('require') as NodeJS.Require;
  const { Resend } = requireResend('resend') as typeof import('resend');
  const resend = new Resend(apiKey);

  try {
    const result = await resend.emails.send({ from: FROM_ADDRESS, to: [to], ...rendered });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    return { ok: true, messageId: result.data?.id ?? 'unknown' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export interface NewLeadEmailVars {
  businessName: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  summary: string | null;
  score: number | null;
  /** The classifier's own justification for `score` — see leads.ts's
   *  header comment on why this exists alongside the number, not just
   *  behind it. */
  scoreReason: string | null;
  channel: string | null;
}

export function buildNewLeadEmail(vars: NewLeadEmailVars): { subject: string; text: string; html: string } {
  const contactParts = [vars.contactName, vars.contactPhone, vars.contactEmail].filter((v): v is string => Boolean(v));
  const contactLine = contactParts.length > 0 ? contactParts.join(' · ') : 'sin datos de contacto';
  const via = vars.channel ? CHANNEL_LABEL[vars.channel] ?? vars.channel : null;
  const priority = vars.score !== null ? ` (prioridad ${vars.score}/100)` : '';

  const subject = `Nuevo lead${priority} — ${contactParts[0] ?? 'sin nombre'}`;
  const text = [
    `Hola ${vars.businessName},`,
    '',
    `Tienes un lead nuevo${via ? ` por ${via}` : ''}${priority}: ${contactLine}.`,
    vars.summary ? '' : null,
    vars.summary ? vars.summary : null,
    vars.scoreReason ? '' : null,
    vars.scoreReason ? `Por qué esta puntuación: ${vars.scoreReason}` : null,
    '',
    `Puedes verlo y contactarlo desde el portal: ${PORTAL_LEADS_URL}`,
    '',
    '— Kairikos',
  ].filter((line): line is string => line !== null).join('\n');
  const html = [
    `<p>Hola ${escapeHtml(vars.businessName)},</p>`,
    `<p>Tienes un lead nuevo${via ? ` por ${escapeHtml(via)}` : ''}${escapeHtml(priority)}: <strong>${escapeHtml(contactLine)}</strong>.</p>`,
    vars.summary ? `<p>${escapeHtml(vars.summary)}</p>` : '',
    vars.scoreReason ? `<p><em>Por qué esta puntuación:</em> ${escapeHtml(vars.scoreReason)}</p>` : '',
    `<p><a href="${escapeHtml(PORTAL_LEADS_URL)}">Ver y contactar el lead</a></p>`,
    '<p>— Kairikos</p>',
  ].filter((line) => line !== '').join('\n');
  return { subject, text, html };
}

/** Sent once, when a genuinely new lead is captured — see this file's
 *  header for why refreshes of an existing 'nuevo' lead must never call
 *  this. */
export async function sendNewLeadEmail(input: { to: string } & NewLeadEmailVars): Promise<SendNewLeadEmailResult> {
  return sendEmail(input.to, buildNewLeadEmail(input));
}

// =============================================================================
// Prospección con IA, Fase A — one email per campaign RUN, never per
// lead. A run can surface a dozen businesses at once (unlike an inbound
// lead, which always arrives one at a time from one conversation), so
// sendNewLeadEmail's per-lead trigger is the wrong shape here — it would
// mean a dozen emails landing in the same minute. Sent from
// prospecting-tick's cron dispatch, only when a run actually created at
// least one Lead.
// =============================================================================

export interface ProspectingBatchEmailVars {
  businessName: string;
  /** How many new Lead rows this run created — NOT detailsCallsMade;
   *  the client cares about new prospects, not the API call count that
   *  produced them. */
  count: number;
}

export function buildProspectingBatchEmail(
  vars: ProspectingBatchEmailVars,
): { subject: string; text: string; html: string } {
  const plural = vars.count === 1 ? 'prospecto nuevo' : 'prospectos nuevos';
  const subject = `${vars.count} ${plural} encontrados`;
  const text = [
    `Hola ${vars.businessName},`,
    '',
    `Encontramos ${vars.count} ${plural} en tu zona. Los tienes en el portal, junto al resto de tus leads.`,
    '',
    `Puedes verlos y contactarlos desde el portal: ${PORTAL_LEADS_URL}`,
    '',
    '— Kairikos',
  ].join('\n');
  const html = [
    `<p>Hola ${escapeHtml(vars.businessName)},</p>`,
    `<p>Encontramos <strong>${vars.count} ${escapeHtml(plural)}</strong> en tu zona. Los tienes en el portal, junto al resto de tus leads.</p>`,
    `<p><a href="${escapeHtml(PORTAL_LEADS_URL)}">Ver y contactar</a></p>`,
    '<p>— Kairikos</p>',
  ].join('\n');
  return { subject, text, html };
}

/** Sent once per campaign run that produced at least one new Lead — the
 *  caller (prospecting-tick) is responsible for that `count > 0` check;
 *  this function doesn't skip on count:0 itself, since a caller might
 *  legitimately want to test the zero-result copy path. */
export async function sendProspectingBatchEmail(
  input: { to: string } & ProspectingBatchEmailVars,
): Promise<SendNewLeadEmailResult> {
  return sendEmail(input.to, buildProspectingBatchEmail(input));
}
