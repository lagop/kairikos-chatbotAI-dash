import 'server-only';
import { notifyFromAddress } from './email-sender';

// =============================================================================
// Aviso inmediato al negocio cuando el bot deriva una conversación.
//
// Por qué existe (22/09/2026): la bandeja de traspaso (Fase 3) estaba
// montada y funcionaba, pero NADIE se enteraba de que había algo esperando.
// El bot le dice a la persona "te paso con alguien del equipo" y el dueño
// del negocio solo se enteraba si entraba al portal por su cuenta. El
// resumen periódico (conversation-digest.ts) cuenta las derivadas, pero es
// opcional, hay que configurarlo y llega tarde por definición.
//
// Calcado de conversation-digest-email.ts: carga perezosa del SDK de
// Resend, nunca lanza, degrada sin RESEND_API_KEY. La conversación ya está
// guardada antes de intentar el envío, así que un email perdido no pierde
// nada — solo retrasa el aviso hasta que alguien mire el portal.
//
// Se manda UNA vez por conversación, cuando se estampa handoffRequestedAt
// (ver chatbot-conversation.ts). Un email por turno convertiría el aviso
// en ruido y el ruido en filtro de spam.
//
// El canal web se avisa distinto a propósito: ahí NO se puede contestar
// (ver chatbot-handoff.ts — el visitante es una pestaña que ya se cerró),
// así que prometer "entra y contéstale" sería mentir. Ver también
// widget-contact, que es la otra mitad de este problema.
// =============================================================================

const FROM_ADDRESS = notifyFromAddress();
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';

const CHANNEL_LABEL: Record<string, string> = {
  web: 'el chat de tu web',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  messenger: 'Messenger',
  instagram: 'Instagram',
};

/** Los cuatro canales por los que una persona SÍ puede contestar desde el
 *  portal. Misma lista que HANDOFF_CHANNELS en chatbot-handoff.ts; se
 *  repite aquí en vez de importarla para que este módulo no arrastre el
 *  resto de aquel, y hay un test que compara las dos. */
const REPLYABLE_CHANNELS = ['whatsapp', 'telegram', 'messenger', 'instagram'];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type SendHandoffAlertEmailResult =
  | { ok: true; messageId: string }
  | { ok: true; skipped: true; messageId: null; reason: 'no_api_key' | 'no_recipient' }
  | { ok: false; error: string };

export interface SendHandoffAlertEmailInput {
  to: string;
  businessName: string;
  conversationId: string;
  channel: string;
  /** Lo último que escribió la persona, para decidir sin abrir el portal. */
  lastMessage: string;
  /** Por qué escaló, en las palabras del modelo. Puede no venir. */
  reason: string | null;
}

function trim(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function buildHandoffAlertEmail(
  vars: Omit<SendHandoffAlertEmailInput, 'to'>,
): { subject: string; text: string; html: string } {
  const channelLabel = CHANNEL_LABEL[vars.channel] ?? vars.channel;
  const url = `${PORTAL_BASE_URL}/portal/conversations/${vars.conversationId}`;
  const canReply = REPLYABLE_CHANNELS.includes(vars.channel);
  const message = trim(vars.lastMessage, 300);
  const reason = vars.reason ? trim(vars.reason, 200) : null;

  const subject = `Alguien espera respuesta en ${channelLabel}`;

  const action = canReply
    ? 'Puedes contestarle tú desde el portal y tu mensaje le llegará por el mismo canal.'
    : 'Ojo: por el chat de la web no se puede contestar — quien escribió ya cerró la página. '
      + 'Si dejó su teléfono o su correo, está en la conversación.';

  const lines = [
    `Hola ${vars.businessName},`,
    '',
    `El chatbot ha derivado una conversación de ${channelLabel} porque no supo resolverla.`,
    '',
    `Lo último que te escribieron: «${message}»`,
    ...(reason ? [`Motivo: ${reason}`] : []),
    '',
    action,
    '',
    `Ver la conversación: ${url}`,
    '',
    '— Kairikos',
  ];

  const html = [
    `<p>Hola ${escapeHtml(vars.businessName)},</p>`,
    `<p>El chatbot ha derivado una conversación de <strong>${escapeHtml(channelLabel)}</strong> porque no supo resolverla.</p>`,
    `<p>Lo último que te escribieron:<br><em>«${escapeHtml(message)}»</em></p>`,
    ...(reason ? [`<p>Motivo: ${escapeHtml(reason)}</p>`] : []),
    `<p>${escapeHtml(action)}</p>`,
    `<p><a href="${escapeHtml(url)}">Ver la conversación en el portal</a></p>`,
    '<p>— Kairikos</p>',
  ].join('\n');

  return { subject, text: lines.join('\n'), html };
}

export async function sendHandoffAlertEmail(
  input: SendHandoffAlertEmailInput,
): Promise<SendHandoffAlertEmailResult> {
  if (!input.to || !input.to.includes('@')) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_recipient' };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_api_key' };
  }

  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);

  try {
    const rendered = buildHandoffAlertEmail(input);
    const result = await resend.emails.send({ from: FROM_ADDRESS, to: [input.to], ...rendered });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    return { ok: true, messageId: result.data?.id ?? 'unknown' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

// =============================================================================
// La otra mitad del problema del canal web: ahí no se puede contestar, así
// que "te paso con alguien del equipo" solo es verdad si la persona deja
// por dónde localizarla. El widget lo pide al derivar (embed.js) y lo
// manda a /api/public/channels/web/contact, que guarda el dato en la
// conversación y avisa con esto.
//
// Es el único aviso del chatbot que pide acción de verdad: hay alguien
// esperando una llamada o un correo que solo puede dar el negocio.
// =============================================================================

export interface SendWidgetContactEmailInput {
  to: string;
  businessName: string;
  conversationId: string;
  /** Lo que escribió la persona en el formulario; puede venir vacío. */
  visitorName: string | null;
  /** Un email o un teléfono, sin interpretar: se enseña tal cual. */
  contact: string;
  lastMessage: string;
}

export function buildWidgetContactEmail(
  vars: Omit<SendWidgetContactEmailInput, 'to'>,
): { subject: string; text: string; html: string } {
  const url = `${PORTAL_BASE_URL}/portal/conversations/${vars.conversationId}`;
  const name = vars.visitorName ? trim(vars.visitorName, 80) : null;
  const contact = trim(vars.contact, 120);
  const message = trim(vars.lastMessage, 300);
  const quien = name ?? 'Alguien';

  const subject = name
    ? `${name} te ha dejado su contacto en el chat de tu web`
    : 'Te han dejado un contacto en el chat de tu web';

  const text = [
    `Hola ${vars.businessName},`,
    '',
    `${quien} escribió en el chat de tu web, el bot no supo resolverlo y dejó cómo localizarle.`,
    '',
    `Contacto: ${contact}`,
    ...(name ? [`Nombre: ${name}`] : []),
    `Lo que preguntaba: «${message}»`,
    '',
    'Escríbele tú: por el chat de la web no se le puede responder, porque ya cerró la página.',
    '',
    `Ver la conversación: ${url}`,
    '',
    '— Kairikos',
  ].join('\n');

  const html = [
    `<p>Hola ${escapeHtml(vars.businessName)},</p>`,
    `<p>${escapeHtml(quien)} escribió en el chat de tu web, el bot no supo resolverlo y dejó cómo localizarle.</p>`,
    `<p><strong>Contacto:</strong> ${escapeHtml(contact)}</p>`,
    ...(name ? [`<p><strong>Nombre:</strong> ${escapeHtml(name)}</p>`] : []),
    `<p>Lo que preguntaba:<br><em>«${escapeHtml(message)}»</em></p>`,
    '<p>Escríbele tú: por el chat de la web no se le puede responder, porque ya cerró la página.</p>',
    `<p><a href="${escapeHtml(url)}">Ver la conversación en el portal</a></p>`,
    '<p>— Kairikos</p>',
  ].join('\n');

  return { subject, text, html };
}

export async function sendWidgetContactEmail(
  input: SendWidgetContactEmailInput,
): Promise<SendHandoffAlertEmailResult> {
  if (!input.to || !input.to.includes('@')) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_recipient' };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: true, skipped: true, messageId: null, reason: 'no_api_key' };
  }

  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);

  try {
    const rendered = buildWidgetContactEmail(input);
    const result = await resend.emails.send({ from: FROM_ADDRESS, to: [input.to], ...rendered });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    return { ok: true, messageId: result.data?.id ?? 'unknown' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
