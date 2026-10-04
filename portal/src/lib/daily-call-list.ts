import 'server-only';
import type { PrismaClient } from '@prisma/client';
import {
  claimDailyOperatorDigest,
  releaseDailyOperatorDigest,
  sendOperatorNotification,
} from './operator-notify';
import { getOperatorAlertRecipients } from './operator-alert-settings';
import { localDateFor, localMinutesFor } from './recall-digest';
import { reportShareUrl } from './prospecting-share';
import { portalBaseUrl } from './portal-base-url';
import { logError } from './observability';

// =============================================================================
// 04/10/2026 — la lista diaria de llamadas.
//
// El plan comercial sin anuncios (presupuesto 0) pasa por llamar a los negocios
// que encuentra la Prospección de la propia Kairikos (la cuenta interna). La
// Prospección ya los encuentra, les prepara el informe de competencia y los
// puntúa; lo que faltaba es que cada mañana alguien supiera A QUIÉN llamar hoy
// y CON QUÉ abrir la conversación. Esto es eso: un correo al operador, de lunes
// a viernes a las 8:30 (hora de Madrid), con los mejores prospectos aún sin
// contactar, su teléfono, el enlace a su informe y un gancho para la llamada.
//
// La lista no rota sola: es «los mejores que siguen en nuevo». Se vacía
// marcando cada lead como contactado (o descartado) en /portal/leads, que es lo
// que hay que hacer de todas formas después de llamar. Así no hace falta llevar
// la cuenta de qué se ha enseñado.
//
// Quien respondió por WhatsApp va primero: es el que más fácil cierra. Nunca
// sale quien pidió que no le contactemos (optedOutAt).
// =============================================================================

export const CALL_LIST_SIZE = 15;
const TIMEZONE = 'Europe/Madrid';
/** 8:30 en Madrid: antes de que el operador empiece a llamar. */
const SEND_AT_MINUTES = 8 * 60 + 30;

/** Lunes a viernes, a partir de las 8:30 en Madrid. Pura. */
export function isCallListDue(now: Date): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short' }).format(now);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return localMinutesFor(now, TIMEZONE) >= SEND_AT_MINUTES;
}

export interface CallListLead {
  id: string;
  contactName: string | null;
  contactPhone: string | null;
  website: string | null;
  searchCategory: string | null;
  searchLocation: string | null;
  score: number | null;
  scoreReason: string | null;
  repliedAt: Date | null;
  competitorSnapshot: { subjectRating: number | null; subjectReviewCount: number | null; shareToken: string | null } | null;
}

/**
 * Con qué abrir la llamada, a partir de lo que se sabe del negocio. Pura.
 *
 * El orden importa: lo más visible para el propio negocio primero. Que no
 * tenga web lo sabe él; que tenga pocas reseñas frente a su competencia lo
 * enseña el informe; las llamadas que pierde es la pregunta que vale para
 * todos los demás.
 */
export function callHook(lead: CallListLead): string {
  if (lead.repliedAt) return 'Te ha contestado por WhatsApp: llámale hoy, está esperando.';
  if (!lead.website) return 'No tiene web. Abre con la web (799 €, con dominio y alojamiento el primer año) y su ficha de Google.';
  const reviews = lead.competitorSnapshot?.subjectReviewCount ?? null;
  const rating = lead.competitorSnapshot?.subjectRating ?? null;
  if (reviews !== null && reviews < 20) {
    return `Solo ${reviews} reseñas en Google. Abre con su informe frente a la competencia y Reseñas (99 €/mes, sin alta).`;
  }
  if (rating !== null && rating < 4.3) {
    return `Nota de ${rating.toFixed(1).replace('.', ',')} en Google. Abre con las reseñas: pedirlas y contestarlas.`;
  }
  return '¿Cuántas llamadas pierde cuando está en una obra? Abre con Llamadas (desde 79 €/mes).';
}

/** Los mejores prospectos de la cuenta interna que aún no se han llamado. */
export async function loadCallList(prisma: PrismaClient, limit = CALL_LIST_SIZE): Promise<CallListLead[]> {
  return prisma.lead.findMany({
    where: {
      client: { isInternal: true },
      source: 'outbound',
      status: 'nuevo',
      optedOutAt: null,
      contactPhone: { not: null },
    },
    orderBy: [
      { repliedAt: { sort: 'desc', nulls: 'last' } },
      { score: { sort: 'desc', nulls: 'last' } },
      { createdAt: 'asc' },
    ],
    take: limit,
    select: {
      id: true,
      contactName: true,
      contactPhone: true,
      website: true,
      searchCategory: true,
      searchLocation: true,
      score: true,
      scoreReason: true,
      repliedAt: true,
      competitorSnapshot: { select: { subjectRating: true, subjectReviewCount: true, shareToken: true } },
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** El correo. Pura, para probar el texto sin enviar nada. */
export function renderCallList(
  leads: readonly CallListLead[],
  origin: string,
  day: string,
): { subject: string; text: string; html: string } {
  const subject = `Llamadas de hoy (${day}): ${leads.length} negocio${leads.length === 1 ? '' : 's'}`;
  const inbox = `${origin}/portal/leads`;
  const lines = leads.map((lead, i) => {
    const name = lead.contactName ?? 'Negocio sin nombre';
    const where = [lead.searchCategory, lead.searchLocation].filter(Boolean).join(' · ');
    const report = lead.competitorSnapshot?.shareToken ? reportShareUrl(origin, lead.competitorSnapshot.shareToken) : null;
    return { i: i + 1, name, phone: lead.contactPhone ?? '', where, hook: callHook(lead), report, why: lead.scoreReason };
  });

  const text = [
    `${leads.length} negocios para llamar hoy, los mejores que siguen sin contactar.`,
    'Después de cada llamada, márcalo como contactado o descartado en la bandeja: así sale de la lista.',
    '',
    ...lines.flatMap((l) => [
      `${l.i}. ${l.name} — ${l.phone}${l.where ? ` (${l.where})` : ''}`,
      `   ${l.hook}`,
      ...(l.why ? [`   Por qué: ${l.why}`] : []),
      ...(l.report ? [`   Informe: ${l.report}`] : []),
    ]),
    '',
    `Bandeja: ${inbox}`,
    '— Kairikos Ops',
  ].join('\n');

  const rows = lines
    .map(
      (l) => `<tr>
  <td style="padding: 10px 0; border-bottom: 1px solid #e5e7eb; vertical-align: top;">
    <p style="margin: 0; font-weight: 600;">${l.i}. ${escapeHtml(l.name)}</p>
    <p style="margin: 2px 0 0;"><a href="tel:${escapeHtml(l.phone.replace(/[^\d+]/g, ''))}" style="color: #111827;">${escapeHtml(l.phone)}</a>${l.where ? ` <span style="color: #6b7280;">· ${escapeHtml(l.where)}</span>` : ''}</p>
    <p style="margin: 6px 0 0;">${escapeHtml(l.hook)}</p>
    ${l.why ? `<p style="margin: 4px 0 0; color: #6b7280; font-size: 13px;">Por qué: ${escapeHtml(l.why)}</p>` : ''}
    ${l.report ? `<p style="margin: 4px 0 0; font-size: 13px;"><a href="${escapeHtml(l.report)}" style="color: #111827;">Ver su informe</a></p>` : ''}
  </td>
</tr>`,
    )
    .join('\n');
  const html = `<!doctype html>
<html lang="es">
  <body style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111;">
    <p style="margin: 0; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b7280;">Kairikos Ops</p>
    <h1 style="margin: 4px 0 8px; font-size: 20px;">Llamadas de hoy</h1>
    <p style="margin: 0 0 12px; color: #374151;">Los mejores negocios que siguen sin contactar. Después de cada llamada, márcalo como contactado o descartado en la <a href="${escapeHtml(inbox)}" style="color: #111827;">bandeja</a>: así sale de la lista.</p>
    <table style="width: 100%; border-collapse: collapse;">${rows}</table>
  </body>
</html>`;
  return { subject, text, html };
}

export type CallListResult =
  | { sent: true; leads: number }
  | { sent: false; reason: 'not_due' | 'already_sent' | 'empty' | 'send_failed' };

/**
 * La pasada del cron: una vez por día laborable, a partir de las 8:30. Un día
 * sin nadie a quien llamar cuenta como hecho (no se reintenta cada 5 minutos)
 * y no manda nada: un correo vacío enseña a no abrirlos.
 */
export async function sendDailyCallList(prisma: PrismaClient, now: Date = new Date()): Promise<CallListResult> {
  if (!isCallListDue(now)) return { sent: false, reason: 'not_due' };
  const day = localDateFor(now, TIMEZONE);

  const claim = await claimDailyOperatorDigest(prisma, { kind: 'daily-call-list', day, subject: `Llamadas de hoy (${day})` });
  if (!claim.claimed) return { sent: false, reason: 'already_sent' };

  const leads = await loadCallList(prisma);
  if (leads.length === 0) return { sent: false, reason: 'empty' };

  const rendered = renderCallList(leads, portalBaseUrl(), day);
  const res = await sendOperatorNotification({
    kind: 'daily-call-list',
    to: await getOperatorAlertRecipients(),
    ...rendered,
  });
  if (!res.ok) {
    logError('daily_call_list.send_failed', new Error(res.error), { day }, 'warn');
    await releaseDailyOperatorDigest(prisma, claim.id);
    return { sent: false, reason: 'send_failed' };
  }
  return { sent: true, leads: leads.length };
}
