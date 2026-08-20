import 'server-only';

// =============================================================================
// Canales Fase 7 — email best-effort al cliente cuando se genera un
// resumen periódico de conversaciones. Calcado de web-quote-email.ts:
// dynamic require del SDK de Resend, nunca lanza, degrada sin
// RESEND_API_KEY. El resumen ya quedó persistido en ConversationDigest
// antes de intentar este envío (ver conversation-digest.ts), así que un
// email perdido no pierde el dato — a diferencia de lo que hoy pasa con
// los leads del Paso 6 del wizard.
// =============================================================================

const FROM_ADDRESS =
  process.env.OPERATOR_NOTIFY_FROM ?? process.env.AUTH_EMAIL_FROM ?? 'Kairikos Ops <ops@kairikos.com>';
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';
const PORTAL_CONVERSATIONS_URL = `${PORTAL_BASE_URL}/portal/conversations`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type SendConversationDigestEmailResult =
  | { ok: true; messageId: string }
  | { ok: true; skipped: true; messageId: null; reason: 'no_api_key' | 'no_recipient' }
  | { ok: false; error: string };

export interface SendConversationDigestEmailInput {
  to: string;
  businessName: string;
  totalConversations: number;
  escalatedCount: number;
  summaryText: string;
  highlights: string[];
}

export function buildConversationDigestEmail(
  vars: Omit<SendConversationDigestEmailInput, 'to'>,
): { subject: string; text: string; html: string } {
  const subject =
    vars.escalatedCount > 0
      ? `Resumen de conversaciones — ${vars.totalConversations} conversaciones, ${vars.escalatedCount} derivadas`
      : `Resumen de conversaciones — ${vars.totalConversations} conversaciones`;

  const highlightLines = vars.highlights.length > 0 ? vars.highlights : ['Nada que requiera tu atención en esta ventana.'];

  const text = [
    `Hola ${vars.businessName},`,
    '',
    vars.summaryText,
    '',
    'Solicitudes a atender:',
    ...highlightLines.map((h) => `- ${h}`),
    '',
    `Puedes ver el detalle completo en el portal: ${PORTAL_CONVERSATIONS_URL}`,
    '',
    '— Kairikos',
  ].join('\n');

  const html = [
    `<p>Hola ${escapeHtml(vars.businessName)},</p>`,
    `<p>${escapeHtml(vars.summaryText)}</p>`,
    '<p><strong>Solicitudes a atender:</strong></p>',
    `<ul>${highlightLines.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`,
    `<p><a href="${escapeHtml(PORTAL_CONVERSATIONS_URL)}">Ver el detalle en el portal</a></p>`,
    '<p>— Kairikos</p>',
  ].join('\n');

  return { subject, text, html };
}

export async function sendConversationDigestEmail(
  input: SendConversationDigestEmailInput,
): Promise<SendConversationDigestEmailResult> {
  if (!input.to || !input.to.includes('@')) {
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
    const rendered = buildConversationDigestEmail(input);
    const result = await resend.emails.send({ from: FROM_ADDRESS, to: [input.to], ...rendered });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    return { ok: true, messageId: result.data?.id ?? 'unknown' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
