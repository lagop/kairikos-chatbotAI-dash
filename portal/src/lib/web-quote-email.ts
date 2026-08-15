import 'server-only';

// =============================================================================
// WebQuote v2 — email notifications to the client when a quote arrives
// and when an invoice is ready to pay. Calcado del patrón de
// review-request-campaign.ts: dynamic `require` for the Resend SDK
// (keeps it out of the Edge bundle), never throws, and returns a typed
// result so callers persist/log the outcome instead of failing the
// request the email is a side effect of.
// =============================================================================

const FROM_ADDRESS =
  process.env.OPERATOR_NOTIFY_FROM ?? process.env.AUTH_EMAIL_FROM ?? 'Kairikos Ops <ops@kairikos.com>';
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';
const PORTAL_WEB_URL = `${PORTAL_BASE_URL}/portal/web`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(cents / 100);
}

export type SendWebQuoteEmailResult =
  | { ok: true; messageId: string }
  | { ok: true; skipped: true; messageId: null; reason: 'no_api_key' | 'no_recipient' }
  | { ok: false; error: string };

async function sendEmail(to: string, rendered: { subject: string; text: string; html: string }): Promise<SendWebQuoteEmailResult> {
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

export function buildWebQuoteSentEmail(vars: {
  businessName: string;
  amountCents: number;
  currency: string;
  description: string;
}): { subject: string; text: string; html: string } {
  const price = formatPrice(vars.amountCents, vars.currency);
  const subject = `Tu presupuesto de web está listo — ${price}`;
  const text = [
    `Hola ${vars.businessName},`,
    '',
    `Preparamos un presupuesto para tu proyecto de web: ${price}.`,
    '',
    vars.description,
    '',
    `Puedes revisarlo y aceptarlo desde el portal: ${PORTAL_WEB_URL}`,
    '',
    '— Kairikos',
  ].join('\n');
  const html = [
    `<p>Hola ${escapeHtml(vars.businessName)},</p>`,
    `<p>Preparamos un presupuesto para tu proyecto de web: <strong>${escapeHtml(price)}</strong>.</p>`,
    `<p>${escapeHtml(vars.description)}</p>`,
    `<p><a href="${escapeHtml(PORTAL_WEB_URL)}">Revisar y aceptar el presupuesto</a></p>`,
    '<p>— Kairikos</p>',
  ].join('\n');
  return { subject, text, html };
}

/** Sent when the operator sends (or re-sends after an edit) a quote. */
export async function sendWebQuoteSentEmail(input: {
  to: string;
  businessName: string;
  amountCents: number;
  currency: string;
  description: string;
}): Promise<SendWebQuoteEmailResult> {
  return sendEmail(input.to, buildWebQuoteSentEmail(input));
}

const INVOICE_ROLE_LABEL: Record<'full' | 'deposit' | 'final', string> = {
  full: 'Tu factura',
  deposit: 'La factura del adelanto',
  final: 'La factura del saldo final',
};

export function buildWebQuoteInvoiceEmail(vars: {
  businessName: string;
  amountCents: number;
  currency: string;
  role: 'full' | 'deposit' | 'final';
  hostInvoiceUrl: string | null;
}): { subject: string; text: string; html: string } {
  const price = formatPrice(vars.amountCents, vars.currency);
  const label = INVOICE_ROLE_LABEL[vars.role];
  const subject = `${label} está lista — ${price}`;
  const payUrl = vars.hostInvoiceUrl ?? PORTAL_WEB_URL;
  const text = [
    `Hola ${vars.businessName},`,
    '',
    `${label} de tu proyecto de web ya está lista: ${price}.`,
    '',
    `Puedes pagarla online aquí: ${payUrl}`,
    '',
    '¿Prefieres pagar por transferencia o efectivo? Escríbenos a soporte y lo coordinamos.',
    '',
    '— Kairikos',
  ].join('\n');
  const html = [
    `<p>Hola ${escapeHtml(vars.businessName)},</p>`,
    `<p>${escapeHtml(label)} de tu proyecto de web ya está lista: <strong>${escapeHtml(price)}</strong>.</p>`,
    `<p><a href="${escapeHtml(payUrl)}">Pagar factura</a></p>`,
    '<p>¿Prefieres pagar por transferencia o efectivo? Escríbenos a soporte y lo coordinamos.</p>',
    '<p>— Kairikos</p>',
  ].join('\n');
  return { subject, text, html };
}

/** Sent when the operator generates an invoice — full, deposit, or final. */
export async function sendWebQuoteInvoiceEmail(input: {
  to: string;
  businessName: string;
  amountCents: number;
  currency: string;
  role: 'full' | 'deposit' | 'final';
  hostInvoiceUrl: string | null;
}): Promise<SendWebQuoteEmailResult> {
  return sendEmail(input.to, buildWebQuoteInvoiceEmail(input));
}
