import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { portalBaseUrl } from './portal-base-url';
import { supportWhatsappUrl } from './portal-data';
import { generatePublicDraft, MAX_GENERATION_ATTEMPTS } from './public-draft-request';
import {
  deliverInboundEmail,
  emailFromContact,
  euros,
  followUpFooter,
  KAIRIKOS_CONTACT_EMAIL,
  newUnsubscribeToken,
  readWebPriceCents,
} from './inbound-follow-up';
import { logError } from './observability';

// =============================================================================
// 30/10/2026 — el borrador de kairikos.com se entrega en menos de 24 horas.
//
// Hasta hoy el formulario esperaba un minuto y enseñaba la web. Dos problemas:
// no daba tiempo a revisar nada antes de que la viera el negocio, y algo que
// sale en segundos cuesta creer que valga varios cientos de euros. Ahora:
//
//   1. La ruta pública guarda la petición y contesta al momento; el borrador
//      se escribe justo después (after() en la ruta). Si eso falla, lo
//      reintenta el barrido, esperando una hora más por cada intento.
//   2. Mientras no se envía, /mi-web/<testigo> enseña «la estamos preparando»
//      y el operador la ve, la retoca o la manda desde /admin/portal/borradores.
//   3. Sale cuando el operador pulsa «Enviar ahora» o, si nadie la ha mirado,
//      sola a las DELIVERY_HOURS de pedirla (decisión de Orlando: mejor una web
//      sin revisar a tiempo que una promesa incumplida).
//
// Al enviarse: sentAt abre el enlace y sale un correo con él. A quien marcó la
// casilla de comunicaciones comerciales le llega la versión con precio, cita y
// baja de un clic, y cuenta como el día 0 de su seguimiento
// (inbound-follow-up.ts, que desde hoy cuenta los días desde sentAt). A quien
// no la marcó, solo el servicio que pidió: su enlace, sin ofertas (art. 21
// LSSI). Quien dejó solo un teléfono —el formulario antiguo— no recibe correo:
// la cola lo marca para llamarle.
//
// Si el correo falla, el enlace queda abierto igual y el motivo se guarda en
// deliveryError: el operador lo ve y puede reintentarlo. No se reintenta solo
// porque los fallos de Resend que hemos visto son de configuración o de una
// dirección mala, y repetirlos cada cinco minutos no arregla ninguno.
// =============================================================================

/** 23 y no 24: el barrido pasa cada cinco minutos y el correo debe llegar
 *  dentro de las 24 horas que promete la web, no a la 24 y pico. */
export const DELIVERY_HOURS = 23;
const HOUR_MS = 60 * 60 * 1000;
/** Lo que se le da a after() antes de que el barrido lo intente por su cuenta. */
const FIRST_RETRY_MS = 2 * 60 * 1000;
/** Cada generación tarda decenas de segundos y el scheduler corta a los 120. */
const MAX_GENERATIONS_PER_SWEEP = 2;
const MAX_RELEASES_PER_SWEEP = 20;
const DELIVERY_TIMEZONE = 'Atlantic/Canary';

// --- Puras -------------------------------------------------------------------

export function deliveryDueAt(createdAt: Date): Date {
  return new Date(createdAt.getTime() + DELIVERY_HOURS * HOUR_MS);
}

/** Si toca reintentar la generación: el primer intento lo hace la ruta; los
 *  siguientes, a la hora, a las dos horas… de pedirla. Así una caída del
 *  modelo de unas horas no agota los intentos en un cuarto de hora. */
export function generationRetryDue(input: { createdAt: Date; generationAttempts: number }, now: Date): boolean {
  if (input.generationAttempts >= MAX_GENERATION_ATTEMPTS) return false;
  const waitMs = Math.max(FIRST_RETRY_MS, input.generationAttempts * HOUR_MS);
  return now.getTime() - input.createdAt.getTime() >= waitMs;
}

const PLAZO = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: DELIVERY_TIMEZONE,
});

/** «sábado 31 de octubre, a las 15:00»: el plazo tal como lo lee alguien de
 *  Canarias, que es a quien se vende. */
export function formatDeliveryDeadline(dueAt: Date): string {
  const parts = Object.fromEntries(PLAZO.formatToParts(dueAt).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day} de ${parts.month}, a las ${parts.hour}:${parts.minute}`;
}

export interface DraftReadyMarketing {
  unsubscribeUrl: string;
  contactUrl: string;
  whatsappUrl: string;
  webPriceCents: number | null;
}

/** El correo que entrega el borrador. Con `marketing`, la versión para quien
 *  aceptó comunicaciones comerciales (precio, cita, WhatsApp y baja); sin él,
 *  solo lo que pidió. */
export function buildDraftReadyEmail(input: {
  businessName: string;
  draftUrl: string;
  marketing: DraftReadyMarketing | null;
}): { subject: string; text: string } {
  const { businessName: negocio, draftUrl, marketing } = input;
  const lines = [
    'Hola,',
    '',
    `Ya está lista la propuesta de web para ${negocio} que pediste en kairikos.com:`,
    draftUrl,
    '',
    'La hemos preparado con los datos públicos de tu ficha de Google. Lo que no te encaje se cambia: textos, fotos, servicios.',
  ];
  if (marketing) {
    lines.push(
      '',
      marketing.webPriceCents !== null
        ? `Si te gusta, la dejamos publicada con tu dominio por ${euros(marketing.webPriceCents)}, pago único, con dominio y alojamiento del primer año incluidos. Es el precio final: no se le suma ningún impuesto.`
        : 'Si te gusta, la dejamos publicada con tu dominio, con dominio y alojamiento del primer año incluidos.',
      '',
      `¿La vemos juntos 20 minutos? Reserva aquí: ${marketing.contactUrl}`,
      `O escríbenos por WhatsApp: ${marketing.whatsappUrl}`,
      ...followUpFooter(marketing),
    );
  } else {
    lines.push(
      '',
      'Si tienes cualquier duda o quieres cambiar algo, responde a este correo.',
      '',
      '—',
      'Orlando Perdomo · Kairikos (kairikos.com)',
      `Te escribimos porque pediste en kairikos.com ver cómo quedaría tu web. Puedes escribirnos a ${KAIRIKOS_CONTACT_EMAIL}. Cómo tratamos tus datos: https://kairikos.com/privacidad/`,
    );
  }
  return { subject: `Ya está la web de ${negocio}`, text: lines.join('\n') };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Lo que enseña /mi-web/<testigo> hasta que se envía. No dice a qué correo
 *  va: el enlace puede reenviarse, y el correo no es de quien lo reciba. */
export function renderPreparingPage(input: { businessName: string; dueAt: Date }): string {
  const negocio = escapeHtml(input.businessName);
  const plazo = escapeHtml(formatDeliveryDeadline(input.dueAt));
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Preparando la web de ${negocio}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f5f2; color: #1d1d1b;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 34rem; margin: 2rem 1rem; padding: 2.5rem 2rem; background: #fff; border-radius: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.05); }
  .marca { font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; color: #6b6a66; margin: 0 0 1.5rem; }
  h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; }
  .plazo { font-weight: 600; }
  .nota { color: #6b6a66; font-size: .95rem; margin: 1.5rem 0 0; }
  a { color: inherit; }
</style>
</head>
<body>
<main>
  <p class="marca">Kairikos</p>
  <h1>Estamos preparando la web de ${negocio}</h1>
  <p>La montamos con los datos públicos de tu ficha de Google y te la mandamos a tu correo <span class="plazo">antes del ${plazo}</span> (hora de Canarias).</p>
  <p>Este mismo enlace la enseñará en cuanto esté lista.</p>
  <p class="nota">¿Alguna idea que quieras que tengamos en cuenta? Escríbenos a <a href="mailto:${KAIRIKOS_CONTACT_EMAIL}">${KAIRIKOS_CONTACT_EMAIL}</a>.</p>
</main>
</body>
</html>`;
}

// --- Envío -------------------------------------------------------------------

export type ReleaseResult =
  /** Enlace abierto y correo enviado. */
  | 'sent'
  /** Enlace abierto; no dejó correo (formulario antiguo, solo teléfono). */
  | 'sent_no_email'
  /** Enlace abierto; el correo falló (queda en deliveryError). */
  | 'email_failed'
  /** Aún no tiene borrador escrito. */
  | 'not_ready'
  /** Ya se había enviado (o no existe). */
  | 'already';

/**
 * Envía un borrador: abre su enlace y le manda el correo. Idempotente: el
 * envío se reserva poniendo sentAt con una condición, así que dos barridos, o
 * el barrido y el botón del operador a la vez, no mandan dos correos.
 *
 * `retryFailed` (solo el botón del operador): también vale si ya se envió pero
 * el correo falló, para reintentarlo.
 */
export async function releasePublicDraft(
  prisma: PrismaClient,
  id: string,
  opts: { now?: Date; retryFailed?: boolean } = {},
): Promise<ReleaseResult> {
  const now = opts.now ?? new Date();
  const claim = await prisma.publicDraftRequest.updateMany({
    where: {
      id,
      copy: { not: Prisma.DbNull },
      ...(opts.retryFailed ? { OR: [{ sentAt: null }, { deliveryError: { not: null } }] } : { sentAt: null }),
    },
    data: { sentAt: now, deliveryError: null },
  });
  if (claim.count === 0) {
    const row = await prisma.publicDraftRequest.findUnique({ where: { id }, select: { sentAt: true, model: true } });
    return row && !row.model ? 'not_ready' : 'already';
  }

  const row = await prisma.publicDraftRequest.findUniqueOrThrow({
    where: { id },
    select: {
      token: true,
      businessName: true,
      contact: true,
      marketingConsentAt: true,
      unsubscribedAt: true,
      unsubscribeToken: true,
    },
  });
  const email = emailFromContact(row.contact);
  if (!email) return 'sent_no_email';

  try {
    const base = portalBaseUrl();
    const consented = row.marketingConsentAt !== null && row.unsubscribedAt === null;
    let marketing: DraftReadyMarketing | null = null;
    if (consented) {
      let token = row.unsubscribeToken;
      if (!token) {
        token = newUnsubscribeToken();
        await prisma.publicDraftRequest.update({ where: { id }, data: { unsubscribeToken: token } });
      }
      marketing = {
        unsubscribeUrl: `${base}/api/public/baja/${token}`,
        contactUrl: 'https://kairikos.com/contacto/',
        whatsappUrl: supportWhatsappUrl('Hola, vengo de kairikos.com'),
        webPriceCents: await readWebPriceCents(prisma),
      };
    }

    const message = buildDraftReadyEmail({ businessName: row.businessName, draftUrl: `${base}/mi-web/${row.token}`, marketing });
    const error = await deliverInboundEmail(email, message, marketing?.unsubscribeUrl ?? null);
    if (error) {
      await prisma.publicDraftRequest.update({ where: { id }, data: { deliveryError: error.slice(0, 500) } });
      return 'email_failed';
    }
    if (marketing) {
      // El día 0 de su seguimiento: así el hueco mínimo entre correos cuenta
      // desde este, y la cola lo enseña como uno más.
      await prisma.inboundFollowUpEmail.createMany({
        data: [{ source: 'web_draft', sourceId: id, email, step: 'dia_0', status: 'sent', sentAt: now }],
        skipDuplicates: true,
      });
    }
    return 'sent';
  } catch (err) {
    logError('public_draft.release_failed', err, { id }, 'warn');
    await prisma.publicDraftRequest
      .update({ where: { id }, data: { deliveryError: err instanceof Error ? err.message.slice(0, 500) : 'unknown' } })
      .catch(() => undefined);
    return 'email_failed';
  }
}

// --- Barrido -----------------------------------------------------------------

export interface PublicDraftSweepResult {
  generated: number;
  generationFailed: number;
  released: number;
  emailFailed: number;
  noEmail: number;
}

/** Lo llama /api/cron/public-drafts cada cinco minutos: escribe los borradores
 *  que after() no llegó a escribir y envía los que cumplen el plazo. */
export async function sweepPublicDrafts(prisma: PrismaClient, now: Date = new Date()): Promise<PublicDraftSweepResult> {
  const result: PublicDraftSweepResult = { generated: 0, generationFailed: 0, released: 0, emailFailed: 0, noEmail: 0 };

  const pending = await prisma.publicDraftRequest.findMany({
    where: {
      copy: { equals: Prisma.DbNull },
      generationAttempts: { lt: MAX_GENERATION_ATTEMPTS },
      createdAt: { gte: new Date(now.getTime() - 2 * 24 * HOUR_MS) },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { id: true, createdAt: true, generationAttempts: true },
  });
  for (const p of pending.filter((p) => generationRetryDue(p, now)).slice(0, MAX_GENERATIONS_PER_SWEEP)) {
    const r = await generatePublicDraft(prisma, p.id);
    if (r === 'generated') result.generated += 1;
    else if (r === 'failed' || r === 'gave_up') result.generationFailed += 1;
  }

  const due = await prisma.publicDraftRequest.findMany({
    where: {
      sentAt: null,
      copy: { not: Prisma.DbNull },
      createdAt: { lte: new Date(now.getTime() - DELIVERY_HOURS * HOUR_MS) },
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_RELEASES_PER_SWEEP,
    select: { id: true },
  });
  for (const d of due) {
    const r = await releasePublicDraft(prisma, d.id, { now });
    if (r === 'sent') result.released += 1;
    else if (r === 'sent_no_email') result.noEmail += 1;
    else if (r === 'email_failed') result.emailFailed += 1;
  }

  return result;
}
