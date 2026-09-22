import 'server-only';
import { notifyFromAddress } from './email-sender';
import type { PrismaClient } from '@prisma/client';
import { logError } from './observability';

// =============================================================================
// Fase 2.2 — aviso inmediato cuando entra una reseña negativa.
//
// Hasta ahora, una reseña de una estrella se sincronizaba en silencio y el
// cliente se enteraba si entraba al portal a mirar. La diferencia entre
// responder en una hora o en una semana es justo lo que se está pagando.
//
// Dos decisiones deliberadas:
//
//   • Se avisa exactamente una vez por reseña (negativeAlertSentAt), no
//     una vez por barrido. El cron de reseñas corre cada pocas horas.
//
//   • Al activar esto, el histórico NO se notifica. Las reseñas negativas
//     anteriores a NEGATIVE_ALERT_MAX_AGE_DAYS se marcan como avisadas sin
//     enviar nada: una reseña de hace ocho meses no es una noticia, y
//     estrenar la función con una avalancha de correos sobre cosas viejas
//     sería la peor primera impresión posible.
// =============================================================================

const FROM_ADDRESS = notifyFromAddress();
const PORTAL_BASE_URL = process.env.NEXT_PUBLIC_PORTAL_URL ?? 'https://portal.kairikos.com';
const PORTAL_REVIEWS_URL = `${PORTAL_BASE_URL}/portal/resenas`;

/** Una reseña con más de esto a la espalda se marca como avisada sin
 *  mandar nada. Cubre el estreno de la función y también un cliente que
 *  conecta hoy su ficha con años de reseñas dentro. */
export const NEGATIVE_ALERT_MAX_AGE_DAYS = 7;

/** 1 y 2 estrellas. Una de 3 es tibia, no urgente. */
export const NEGATIVE_STAR_THRESHOLD = 2;

/** Cuántas se miran por barrido — cota superior de correos por tick. */
const ALERT_BATCH_SIZE = 25;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type SendNegativeReviewAlertResult =
  | { ok: true; messageId: string }
  | { ok: true; skipped: true; reason: 'no_api_key' | 'no_recipient' }
  | { ok: false; error: string };

export interface NegativeReviewEmailVars {
  businessName: string;
  reviewerName: string | null;
  starRating: number;
  comment: string | null;
}

export function buildNegativeReviewEmail(vars: NegativeReviewEmailVars): {
  subject: string;
  text: string;
  html: string;
} {
  const who = vars.reviewerName ?? 'Alguien';
  const stars = `${vars.starRating} ${vars.starRating === 1 ? 'estrella' : 'estrellas'}`;

  const subject = `Reseña de ${stars} en tu ficha de Google`;
  const text = [
    `Hola ${vars.businessName},`,
    '',
    `${who} te ha dejado una reseña de ${stars} en Google.`,
    vars.comment ? '' : null,
    vars.comment ? `"${vars.comment}"` : null,
    '',
    'Responder pronto y bien es lo que más pesa: quien lea esa reseña dentro de un mes verá también tu respuesta.',
    `Tienes un borrador listo para revisar en el portal: ${PORTAL_REVIEWS_URL}`,
    '',
    '— Kairikos',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  const html = [
    `<p>Hola ${escapeHtml(vars.businessName)},</p>`,
    `<p><strong>${escapeHtml(who)}</strong> te ha dejado una reseña de <strong>${escapeHtml(stars)}</strong> en Google.</p>`,
    vars.comment ? `<blockquote>${escapeHtml(vars.comment)}</blockquote>` : '',
    '<p>Responder pronto y bien es lo que más pesa: quien lea esa reseña dentro de un mes verá también tu respuesta.</p>',
    `<p><a href="${escapeHtml(PORTAL_REVIEWS_URL)}">Revisar y responder</a></p>`,
    '<p>— Kairikos</p>',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { subject, text, html };
}

/** Mismo patrón de envío que leads-email.ts: `require` dinámico del SDK
 *  para que no entre en el bundle Edge, y nunca lanza. */
export async function sendNegativeReviewAlert(
  input: { to: string } & NegativeReviewEmailVars,
): Promise<SendNegativeReviewAlertResult> {
  if (!input.to || !input.to.includes('@')) {
    return { ok: true, skipped: true, reason: 'no_recipient' };
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: true, skipped: true, reason: 'no_api_key' };
  }

  const { Resend } = await import('resend');
  const resend = new Resend(apiKey);

  try {
    const result = await resend.emails.send({
      from: FROM_ADDRESS,
      to: [input.to],
      ...buildNegativeReviewEmail(input),
    });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true, messageId: result.data?.id ?? 'unknown' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

/** Pura: decide si una reseña merece aviso o solo marcarse. Aislada para
 *  poder probar el corte por antigüedad sin base de datos ni correo. */
export function shouldAlertForReview(createTime: Date, now: Date): boolean {
  return now.getTime() - createTime.getTime() <= NEGATIVE_ALERT_MAX_AGE_DAYS * 24 * 60 * 60_000;
}

export interface NegativeAlertSweepResult {
  /** Reseñas negativas sin avisar que se han mirado. */
  found: number;
  /** Avisos enviados de verdad. */
  alerted: number;
  /** Marcadas sin enviar por ser demasiado antiguas. */
  suppressedOld: number;
}

/**
 * Recorre las reseñas negativas todavía sin avisar de un cliente y manda
 * (como mucho) un correo por cada una. Se llama desde el sync de reseñas,
 * aislado, para que un fallo de correo no convierta una sincronización
 * correcta en un error.
 */
export async function sweepNegativeReviewAlerts(
  prisma: PrismaClient,
  clientId: string,
  now: Date = new Date(),
): Promise<NegativeAlertSweepResult> {
  const pending = await prisma.googleReview.findMany({
    where: {
      clientId,
      starRating: { lte: NEGATIVE_STAR_THRESHOLD },
      negativeAlertSentAt: null,
    },
    orderBy: { createTime: 'desc' },
    take: ALERT_BATCH_SIZE,
    select: { id: true, reviewerName: true, starRating: true, comment: true, createTime: true },
  });

  if (pending.length === 0) {
    return { found: 0, alerted: 0, suppressedOld: 0 };
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: clientId },
    select: { email: true, name: true, companyName: true },
  });
  const businessName = client?.companyName ?? client?.name ?? 'tu negocio';

  let alerted = 0;
  let suppressedOld = 0;

  for (const review of pending) {
    if (shouldAlertForReview(review.createTime, now)) {
      const result = await sendNegativeReviewAlert({
        to: client?.email ?? '',
        businessName,
        reviewerName: review.reviewerName,
        starRating: review.starRating,
        comment: review.comment,
      });
      if (!result.ok) {
        // El sello NO se pone: un fallo de envío se reintenta en el
        // siguiente barrido, que es justo lo contrario de una reseña vieja.
        logError('review_alerts.send_failed', new Error(result.error), { reviewId: review.id }, 'warn');
        continue;
      }
      alerted += 1;
    } else {
      suppressedOld += 1;
    }

    await prisma.googleReview.update({
      where: { id: review.id },
      data: { negativeAlertSentAt: now },
    });
  }

  return { found: pending.length, alerted, suppressedOld };
}
