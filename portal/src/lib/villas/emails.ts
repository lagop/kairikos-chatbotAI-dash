import 'server-only';
import { notifyFromAddress } from '@/lib/email-sender';
import { portalBaseUrl } from '@/lib/portal-base-url';
import { formatCents } from './pricing';
import { toDbDate, type IsoDate } from './dates';

// =============================================================================
// Reserva propia para villas — los avisos por correo.
//
// Mismo molde que el resto de correos del portal (handoff-alert-email.ts): SDK
// de Resend con `await import` (nunca `(0, eval)('require')`, ver CLAUDE.md),
// remitente de notifyFromAddress(), nunca lanza, degrada sin RESEND_API_KEY.
// La solicitud ya está guardada antes de intentar el envío: un correo perdido
// retrasa un aviso, no pierde una reserva.
//
// Al huésped se le escribe en su idioma (es/en) y con el reply-to del dueño:
// si contesta, le contesta a él, no a Kairikos. Al dueño, con el reply-to del
// huésped, por lo mismo.
//
// Los textos no prometen nada que no haga el código: «hasta entonces no se
// cobra nada» es cierto porque el depósito solo se puede pagar tras aceptar.
// =============================================================================


export type Lang = 'es' | 'en';

export interface StaySummary {
  reference: string;
  villaName: string;
  businessName: string;
  checkIn: IsoDate;
  checkOut: IsoDate;
  nights: number;
  adults: number;
  children: number;
  totalCents: number;
  vatCents: number;
  depositCents: number;
  currency: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function formatDay(iso: IsoDate, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'es-ES', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(toDbDate(iso));
}

export function formatDeadline(date: Date, lang: Lang, timeZone = 'Europe/Madrid'): string {
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(date);
}

const money = (cents: number, currency: string, lang: Lang) => formatCents(cents, currency, lang === 'en' ? 'en-GB' : 'es-ES');

function guestsLabel(adults: number, children: number, lang: Lang): string {
  if (lang === 'en') {
    const a = `${adults} adult${adults === 1 ? '' : 's'}`;
    return children ? `${a}, ${children} child${children === 1 ? '' : 'ren'}` : a;
  }
  const a = `${adults} adulto${adults === 1 ? '' : 's'}`;
  return children ? `${a}, ${children} niño${children === 1 ? '' : 's'}` : a;
}

function summaryRows(s: StaySummary, lang: Lang): Array<[string, string]> {
  const en = lang === 'en';
  return [
    [en ? 'Reference' : 'Referencia', s.reference],
    [en ? 'Villa' : 'Villa', s.villaName],
    [en ? 'Arrival' : 'Llegada', formatDay(s.checkIn, lang)],
    [en ? 'Departure' : 'Salida', formatDay(s.checkOut, lang)],
    [en ? 'Nights' : 'Noches', String(s.nights)],
    [en ? 'Guests' : 'Huéspedes', guestsLabel(s.adults, s.children, lang)],
    [en ? 'Total (VAT included)' : 'Total (IVA incluido)', money(s.totalCents, s.currency, lang)],
    [en ? 'Deposit' : 'Depósito', money(s.depositCents, s.currency, lang)],
    [en ? 'Balance' : 'Resto', money(s.totalCents - s.depositCents, s.currency, lang)],
  ];
}

function render(subject: string, paragraphs: string[], rows: Array<[string, string]>, link: { label: string; url: string } | null, signature: string): RenderedEmail {
  const text = [
    ...paragraphs.flatMap((p) => [p, '']),
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    ...(link ? [`${link.label}: ${link.url}`, ''] : []),
    signature,
  ].join('\n');
  const html = [
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    '<table cellpadding="4" style="border-collapse:collapse">',
    ...rows.map(([k, v]) => `<tr><td style="color:#555">${escapeHtml(k)}</td><td><strong>${escapeHtml(v)}</strong></td></tr>`),
    '</table>',
    ...(link ? [`<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`] : []),
    `<p>${escapeHtml(signature)}</p>`,
  ].join('\n');
  return { subject, text, html };
}

export function guestRequestUrl(guestToken: string): string {
  return `${portalBaseUrl()}/reserva-villa/${guestToken}`;
}

// --- Al dueño ------------------------------------------------------------------

export function buildOwnerNewRequestEmail(
  s: StaySummary,
  extra: { guestName: string; guestEmail: string; guestPhone: string | null; message: string | null; expiresAt: Date; timeZone: string },
): RenderedEmail {
  const subject = `Nueva solicitud · ${s.villaName} · ${formatDay(s.checkIn, 'es')} (${s.nights} noches)`;
  const paragraphs = [
    `${extra.guestName} quiere reservar ${s.villaName}. Todavía no se ha cobrado nada.`,
    'Antes de aceptar, mira que esas fechas sigan libres en Airbnb y Booking. Al aceptar, el portal vuelve a leer tus calendarios y no te deja si aparece un solape. El huésped recibe entonces el enlace para pagar el depósito.',
    `Tienes hasta el ${formatDeadline(extra.expiresAt, 'es', extra.timeZone)} para contestar; después la solicitud caduca y se avisa al huésped.`,
    ...(extra.message ? [`Mensaje del huésped: «${extra.message}»`] : []),
  ];
  const rows: Array<[string, string]> = [
    ...summaryRows(s, 'es'),
    ['Email', extra.guestEmail],
    ...(extra.guestPhone ? ([['Teléfono', extra.guestPhone]] as Array<[string, string]>) : []),
  ];
  return render(subject, paragraphs, rows, { label: 'Aceptar o rechazar en el portal', url: `${portalBaseUrl()}/portal/villas` }, '— Kairikos');
}

export function buildOwnerPaidEmail(s: StaySummary, guestName: string): RenderedEmail {
  return render(
    `Depósito pagado · ${s.villaName} · ${formatDay(s.checkIn, 'es')}`,
    [
      `${guestName} ha pagado el depósito: la reserva ${s.reference} está confirmada.`,
      'Las fechas ya salen ocupadas en el calendario que leen Airbnb y Booking (lo actualizan cada pocas horas). Si tenías otras solicitudes para esas noches, se han rechazado solas y se ha avisado a esos huéspedes.',
    ],
    summaryRows(s, 'es'),
    { label: 'Ver en el portal', url: `${portalBaseUrl()}/portal/villas` },
    '— Kairikos',
  );
}

/**
 * Baja del cliente (exit-rules.ts): lo sale el cron una vez, al ver la
 * contratación cancelada. Tres cosas que el dueño tiene que hacer antes de
 * `graceEndsAt`, en el orden en que importan: quitar nuestro iCal de las
 * plataformas (o seguirán bloqueando fechas), llevarse sus datos y quitar el
 * widget de su web.
 */
export function buildOwnerExitEmail(input: {
  businessName: string;
  graceEndsAt: Date;
  timeZone: string;
  villaNames: string[];
  upcomingConfirmed: number;
}): RenderedEmail {
  const deadline = formatDeadline(input.graceEndsAt, 'es', input.timeZone);
  const villas = input.villaNames.length > 0 ? input.villaNames.join(', ') : 'tus villas';
  return render(
    `Baja de la reserva de villas · tienes hasta el ${deadline} para llevarte tus datos`,
    [
      `La reserva propia de ${input.businessName} se ha dado de baja. Ya no entran solicitudes nuevas desde tu web; tus datos siguen en el portal hasta el ${deadline} y después se borran.`,
      `1. Quita de Airbnb y Booking la URL de calendario de Kairikos de cada villa (${villas}). Desde hoy no se actualiza: hasta esa fecha sigue enseñando las fechas que había ocupadas, para que nadie te reserve encima, pero cualquier cambio tuyo ya no llegará. En Airbnb: Calendario → Disponibilidad → Conectar calendarios. En Booking: Tarifas y disponibilidad → Sincronizar calendarios.`,
      '2. Descarga tus datos desde el portal: las solicitudes y reservas con los datos de cada huésped, tus villas con precios y temporadas, un calendario .ics por villa y el registro de cambios.',
      `3. Quita el calendario de reservas de tu web, o cambia el enlace por tu nuevo sistema. Mientras siga puesto, enseña el contacto alternativo que hayas configurado o no enseña nada.`,
      input.upcomingConfirmed > 0
        ? `Tienes ${input.upcomingConfirmed} reserva(s) confirmada(s) por venir: siguen valiendo. Los datos de esos huéspedes están en la exportación y los depósitos, en tu cuenta de Stripe.`
        : 'No tienes reservas confirmadas por venir.',
    ],
    [],
    { label: 'Descargar mis datos', url: `${portalBaseUrl()}/portal/villas` },
    '— Kairikos',
  );
}

// --- Al huésped ----------------------------------------------------------------

export type GuestEmailKind = 'received' | 'accepted' | 'declined' | 'expired_pending' | 'expired_payment' | 'confirmed' | 'cancelled';

export function buildGuestEmail(
  kind: GuestEmailKind,
  s: StaySummary,
  ctx: {
    lang: Lang;
    guestName: string;
    guestToken: string;
    confirmHours: number;
    paymentDueAt: Date | null;
    balanceNote: string | null;
    ownerPhone: string | null;
    timeZone: string;
  },
): RenderedEmail {
  const en = ctx.lang === 'en';
  const hi = en ? `Hello ${ctx.guestName},` : `Hola, ${ctx.guestName}:`;
  const statusLink = { label: en ? 'See your request' : 'Ver tu solicitud', url: guestRequestUrl(ctx.guestToken) };
  const contact = ctx.ownerPhone ? (en ? ` You can also call ${ctx.ownerPhone}.` : ` También puedes llamar al ${ctx.ownerPhone}.`) : '';
  const rows = summaryRows(s, ctx.lang);
  const sign = s.businessName;

  switch (kind) {
    case 'received':
      return render(
        en ? `We have received your request · ${s.villaName}` : `Hemos recibido tu solicitud · ${s.villaName}`,
        [
          hi,
          en
            ? `Thank you for your request. The host confirms within ${ctx.confirmHours} hours; until then nothing is charged.`
            : `Gracias por tu solicitud. El anfitrión confirma en menos de ${ctx.confirmHours} horas; hasta entonces no se cobra nada.`,
          en
            ? 'If the host accepts, you will receive a link to pay the deposit and confirm the booking.'
            : 'Si el anfitrión la acepta, te llegará un enlace para pagar el depósito y confirmar la reserva.',
        ],
        rows,
        statusLink,
        sign,
      );
    case 'accepted': {
      const due = ctx.paymentDueAt ? formatDeadline(ctx.paymentDueAt, ctx.lang, ctx.timeZone) : '';
      return render(
        en ? `Your request has been accepted · pay the deposit to confirm` : `Tu solicitud está aceptada · paga el depósito para confirmarla`,
        [
          hi,
          en
            ? `Good news: ${s.businessName} has accepted your request for ${s.villaName}. To confirm the booking, pay the deposit of ${money(s.depositCents, s.currency, 'en')} before ${due}.`
            : `Buenas noticias: ${s.businessName} ha aceptado tu solicitud para ${s.villaName}. Para confirmar la reserva, paga el depósito de ${money(s.depositCents, s.currency, 'es')} antes del ${due}.`,
          en
            ? 'Payment is made on Stripe’s secure page; your card details never reach this website. If it is not paid in time, the dates are released.'
            : 'El pago se hace en la página segura de Stripe; los datos de tu tarjeta no pasan por esta web. Si no se paga a tiempo, las fechas quedan libres.',
          ...(ctx.balanceNote ? [ctx.balanceNote] : []),
        ],
        rows,
        { label: en ? 'Pay the deposit' : 'Pagar el depósito', url: guestRequestUrl(ctx.guestToken) },
        sign,
      );
    }
    case 'declined':
      return render(
        en ? `Your request could not be accepted · ${s.villaName}` : `No hemos podido aceptar tu solicitud · ${s.villaName}`,
        [
          hi,
          en
            ? `We are sorry: ${s.villaName} is not available on those dates. Nothing has been charged.`
            : `Lo sentimos: ${s.villaName} no está disponible en esas fechas. No se ha cobrado nada.`,
          (en ? 'You are welcome to try other dates.' : 'Si te encajan otras fechas, estaremos encantados de recibirte.') + contact,
        ],
        rows,
        null,
        sign,
      );
    case 'expired_pending':
      return render(
        en ? `Your request has expired · ${s.villaName}` : `Tu solicitud ha caducado · ${s.villaName}`,
        [
          hi,
          en
            ? `The host could not answer your request in time, so it has expired. Nothing has been charged.`
            : `El anfitrión no ha podido contestar a tiempo y la solicitud ha caducado. No se ha cobrado nada.`,
          (en ? 'You can send a new request whenever you like.' : 'Puedes enviar otra cuando quieras.') + contact,
        ],
        rows,
        null,
        sign,
      );
    case 'expired_payment':
      return render(
        en ? `The deposit deadline has passed · ${s.villaName}` : `Ha vencido el plazo del depósito · ${s.villaName}`,
        [
          hi,
          en
            ? 'The deposit was not paid in time, so the dates have been released. Nothing has been charged.'
            : 'El depósito no se pagó a tiempo y las fechas han quedado libres. No se ha cobrado nada.',
          (en ? 'If you still want to come, send a new request.' : 'Si todavía quieres venir, envía una nueva solicitud.') + contact,
        ],
        rows,
        null,
        sign,
      );
    case 'confirmed':
      return render(
        en ? `Booking confirmed · ${s.villaName}` : `Reserva confirmada · ${s.villaName}`,
        [
          hi,
          en
            ? `We have received your deposit of ${money(s.depositCents, s.currency, 'en')}. Your booking is confirmed.`
            : `Hemos recibido tu depósito de ${money(s.depositCents, s.currency, 'es')}. Tu reserva está confirmada.`,
          ...(ctx.balanceNote ? [ctx.balanceNote] : []),
          (en ? 'For anything about your stay, reply to this email.' : 'Para cualquier cosa de tu estancia, contesta a este correo.') + contact,
        ],
        rows,
        statusLink,
        sign,
      );
    case 'cancelled':
      return render(
        en ? `Your booking has been cancelled · ${s.villaName}` : `Tu reserva se ha cancelado · ${s.villaName}`,
        [
          hi,
          en
            ? `${s.businessName} has cancelled booking ${s.reference}. If you paid a deposit, the host will contact you about the refund.`
            : `${s.businessName} ha cancelado la reserva ${s.reference}. Si pagaste un depósito, el anfitrión se pondrá en contacto contigo para la devolución.`,
          (en ? 'Reply to this email if you have any questions.' : 'Si tienes cualquier duda, contesta a este correo.') + contact,
        ],
        rows,
        null,
        sign,
      );
  }
}

// --- Envío ---------------------------------------------------------------------

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: true; skipped: true; reason: 'no_api_key' | 'no_recipient' }
  | { ok: false; error: string };

export async function sendVillaEmail(to: string | null, email: RenderedEmail, replyTo?: string | null): Promise<SendResult> {
  if (!to || !to.includes('@')) return { ok: true, skipped: true, reason: 'no_recipient' };
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: true, skipped: true, reason: 'no_api_key' };
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from: notifyFromAddress(),
      to: [to],
      ...(replyTo && replyTo.includes('@') ? { replyTo } : {}),
      ...email,
    });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true, messageId: result.data?.id ?? 'unknown' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'send_failed' };
  }
}
