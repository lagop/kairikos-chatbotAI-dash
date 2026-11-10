import 'server-only';
import { notifyFromAddress } from './email-sender';
import { maintenanceLine } from './custom-care-rules';

// =============================================================================
// WebQuote v2 — email notifications to the client when a quote arrives
// and when an invoice is ready to pay. Calcado del patrón de
// review-request-campaign.ts: dynamic `require` for the Resend SDK
// (keeps it out of the Edge bundle), never throws, and returns a typed
// result so callers persist/log the outcome instead of failing the
// request the email is a side effect of.
// =============================================================================

const FROM_ADDRESS = notifyFromAddress();
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

  // 22/09/2026 — aquí el SDK se pedía con un require sacado de un eval,
  // copiado de review-request-campaign.ts y de ahí a otros seis módulos.
  // En desarrollo funciona; en la compilación de producción NO existe
  // `require`, así que cada envío moría con "require is not defined",
  // logError lo anotaba como warn y la ruta seguía como si nada. Ningún
  // email de Resend salvo los de auth-email.ts (que siempre usó import
  // normal) ha salido jamás de producción. Se cambió a import dinámico,
  // que sigue siendo perezoso y sí existe en el bundle. Hay un test que
  // impide que el truco vuelva.
  const { Resend } = await import('resend');
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
  /** 11/11/2026 — la cuota de mantenimiento; null = sin mantenimiento, y se dice. */
  monthlyCents: number | null;
  monthlyStartsAfterMonths: number;
}): { subject: string; text: string; html: string } {
  const price = formatPrice(vars.amountCents, vars.currency);
  const maintenance = maintenanceLine(vars.monthlyCents, vars.monthlyStartsAfterMonths, vars.currency);
  const subject = `Tu presupuesto de web está listo — ${price}`;
  const text = [
    `Hola ${vars.businessName},`,
    '',
    `Preparamos un presupuesto para tu proyecto de web: ${price}.`,
    '',
    vars.description,
    '',
    maintenance,
    '',
    `Puedes revisarlo y aceptarlo desde el portal: ${PORTAL_WEB_URL}`,
    '',
    '— Kairikos',
  ].join('\n');
  const html = [
    `<p>Hola ${escapeHtml(vars.businessName)},</p>`,
    `<p>Preparamos un presupuesto para tu proyecto de web: <strong>${escapeHtml(price)}</strong>.</p>`,
    `<p>${escapeHtml(vars.description)}</p>`,
    `<p>${escapeHtml(maintenance)}</p>`,
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
  monthlyCents: number | null;
  monthlyStartsAfterMonths: number;
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

// -----------------------------------------------------------------------------
// 10/11/2026 — oferta de mantenimiento a medida para una web que ya existe
// («solo mantenimiento», lib/custom-care.ts). Sin este correo la oferta solo
// se veía si el cliente entraba por su cuenta en la página de su web.
//
// La fecha de la primera cuota NO va en el correo: Stripe la calcula desde el
// día en que el cliente activa, no desde hoy. Se dice en meses; la fecha
// exacta la ve en el portal antes de guardar la tarjeta.
//
// Las ofertas que nacen al pagarse un presupuesto con cuota no lo mandan: el
// cliente ya leyó la cuota en el correo y en la tarjeta del presupuesto.
// -----------------------------------------------------------------------------

export function buildCustomCareOfferEmail(vars: {
  businessName: string;
  priceCents: number;
  currency: string;
  trialMonths: number;
  webClientProductId: string;
}): { subject: string; text: string; html: string } {
  const price = formatPrice(vars.priceCents, vars.currency);
  const url = `${PORTAL_WEB_URL}/${vars.webClientProductId}`;
  const subject = `El mantenimiento de tu web — ${price}/mes`;
  const when =
    vars.trialMonths <= 0
      ? 'La primera cuota se cobra al activarlo, y después cada mes.'
      : vars.trialMonths === 1
        ? 'Al activarlo no se te cobra nada: la primera cuota llega al mes siguiente, y después cada mes.'
        : `Al activarlo no se te cobra nada: la primera cuota llega ${vars.trialMonths} meses después, y después cada mes.`;
  const lines = [
    `Te hemos preparado el mantenimiento de tu web, con el precio que acordamos: ${price}/mes.`,
    'Incluye el alojamiento, el dominio, las copias de seguridad y los cambios que pactamos.',
    `Para activarlo, entra en la página de tu web en el portal y guarda tu tarjeta. ${when} Sin permanencia.`,
  ];
  const text = [`Hola ${vars.businessName},`, '', ...lines.flatMap((l) => [l, '']), `Activarlo: ${url}`, '', '— Kairikos'].join('\n');
  const html = [
    `<p>Hola ${escapeHtml(vars.businessName)},</p>`,
    ...lines.map((l) => `<p>${escapeHtml(l)}</p>`),
    `<p><a href="${escapeHtml(url)}">Activar el mantenimiento</a></p>`,
    '<p>— Kairikos</p>',
  ].join('\n');
  return { subject, text, html };
}

export async function sendCustomCareOfferEmail(input: {
  to: string;
  businessName: string;
  priceCents: number;
  currency: string;
  trialMonths: number;
  webClientProductId: string;
}): Promise<SendWebQuoteEmailResult> {
  return sendEmail(input.to, buildCustomCareOfferEmail(input));
}
