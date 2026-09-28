import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { sendTemplate, getPhoneNumberInfo } from './whatsapp-api';
import { metaSenderFor } from './recall-messaging';
import { logError } from './observability';
import {
  MAX_CONTACTOS_POR_DIA,
  normalizarPresentacion,
  nombreRemitente,
  parametrosDelPaso,
  pasoUsaPresentacion,
  SEGUIMIENTOS,
} from './prospecting-presentacion';
import { phonesMatch } from './prospecting-replies';

// =============================================================================
// Prospección con IA, Fase C — the highest-risk piece of this product:
// messaging a prospect who never asked to hear from the client, from the
// client's OWN WhatsApp number. See the session's plan for why this is
// gated behind explicit consent and stays the last phase, not the first.
//
// Nothing sends unless the client has explicitly opted in
// (ProspectingCampaign.consentAcknowledgedAt/consentVersion, set via
// PATCH /api/portal/prospecting/campaign/consent) — there is no default-on
// path anywhere in this module.
//
// The quality-rating gate below reads MetaChannelConnection.qualityRating
// LIVE from Meta on every run rather than trusting the stored mirror
// (that column is currently only ever written at connect time — see
// recall-meta.ts — so trusting it here could mean gating on a
// months-stale value for exactly the check that matters most). A
// check that fails outright fails CLOSED: skip sending, never send blind.
//
// Fase 3.3 — dejó de ser un solo mensaje. La secuencia (PROSPECTING_SEQUENCE)
// son tres toques espaciados que se cortan en seco en cuanto el prospecto
// contesta; quien detecta esa respuesta es prospecting-replies.ts, no este
// módulo, que solo lee `repliedAt`. Los tres toques comparten el mismo cupo
// diario y la misma puerta de calidad que el primero: para el número del
// cliente son todos igual de mensaje en frío.
// =============================================================================

/** Bumping this string is how a future change to the consent copy in
 *  ProspectingProfileCard.tsx invalidates old consent automatically —
 *  the send gate below compares this against the stored consentVersion,
 *  not just checking consentAcknowledgedAt is non-null.
 *
 *  v2 (28/09/2026): cambió el primer mensaje —ver prospecting-presentacion.ts—
 *  y el consentimiento pasó a ENSEÑARLO. Con la v1 el cliente autorizaba que
 *  se escribiera en su nombre sin haber visto nunca qué se escribía. Ese día
 *  ninguna campaña tenía el consentimiento dado, así que subir la versión no
 *  le quitó el permiso a nadie.
 *
 *  v3 (28/09/2026, el mismo día): cambió el primer seguimiento —el que
 *  prometía «no volvemos a escribirte» antes de mandar el segundo—. El
 *  cliente autoriza los tres mensajes que ve, así que un texto nuevo pide
 *  permiso nuevo. Tampoco había ningún consentimiento dado. */
export const PROSPECTING_CONSENT_VERSION = 'v3';

/**
 * The template Meta has to approve for this product. Same contract as
 * RECALL_TEMPLATES in recall-messaging.ts: name/language/param count is
 * what was submitted to Meta — changing any of it means resubmitting.
 * {{1}} the prospect's own name (from Place Details), {{2}} the client's
 * business name (who is reaching out).
 */
export const PROSPECTING_TEMPLATES = {
  // v2 desde el 28/09/2026: el texto vive en prospecting-presentacion.ts.
  // Nombre nuevo porque la v1 ya estaba aprobada en Meta, y en WhatsApp viaja
  // el cuerpo aprobado — cambiar el texto con el mismo nombre no cambia lo que
  // se envía. La v1 NO se conserva como respaldo de envío (a diferencia de
  // recall): lo que había que dejar de enviar era justo su texto.
  firstContact: { name: 'prospecting_first_contact_v2', languageCode: 'es' },
  // Fase 3.3 — los dos toques de seguimiento. Cuántos parámetros lleva cada
  // uno ya no se escribe aquí: sale de su texto (parametrosDelPaso).
  //
  // BLOQUEO EXTERNO: como `prospecting_first_contact`, estas dos plantillas
  // necesitan aprobación de Meta antes de que la secuencia envíe nada. Sin
  // aprobar, sendTemplate falla y el lead consume presupuesto de reintentos
  // (autoContactAttempts) sin gastar toque — que es el comportamiento
  // correcto, pero conviene saber que es esto y no un número malo.
  // v2 desde el 28/09/2026 — la v1 prometía no volver a escribir y el paso
  // siguiente volvía a escribir. Ver SEGUIMIENTOS en prospecting-presentacion.ts.
  followUp1: { name: 'prospecting_follow_up_1_v2', languageCode: 'es' },
  followUp2: { name: 'prospecting_follow_up_2', languageCode: 'es' },
} as const;

export interface ProspectingSequenceStep {
  /** 1 es el primer contacto. Coincide con el valor que toma
   *  Lead.followUpCount UNA VEZ enviado este toque. */
  step: number;
  template: { name: string; languageCode: string };
  /** Días de espera desde el toque anterior. El primero no espera. */
  delayDays: number;
}

/**
 * La cadencia. Tres toques es el estándar del sector para prospección en
 * frío y también el techo: a partir del cuarto, la tasa de respuesta ya no
 * sube y la de denuncias sí — y aquí el que se juega la reputación del
 * número es el cliente, no nosotros.
 *
 * Los huecos (3 y 7 días) se miden desde el toque anterior, no desde el
 * primer contacto, para que un tick perdido retrase la secuencia en vez de
 * amontonar dos toques seguidos.
 */
export const PROSPECTING_SEQUENCE: readonly ProspectingSequenceStep[] = Object.freeze([
  { step: 1, template: PROSPECTING_TEMPLATES.firstContact, delayDays: 0 },
  { step: 2, template: PROSPECTING_TEMPLATES.followUp1, delayDays: SEGUIMIENTOS[0].diasDespues },
  { step: 3, template: PROSPECTING_TEMPLATES.followUp2, delayDays: SEGUIMIENTOS[1].diasDespues },
]);

export const MAX_SEQUENCE_TOUCHES = PROSPECTING_SEQUENCE.length;

/** El toque que le toca a un lead que ya ha recibido `followUpCount`.
 *  `null` = secuencia agotada, no se le escribe más. */
export function nextSequenceStep(followUpCount: number): ProspectingSequenceStep | null {
  return PROSPECTING_SEQUENCE.find((s) => s.step === followUpCount + 1) ?? null;
}

/** Hard, product-wide ceiling — not tier-scaled, deliberately. This is a
 *  number-reputation safety brake, not a revenue lever: a burst of cold
 *  messages in one day is exactly the pattern that gets a number reported
 *  and its quality rating tanked, which is the one failure mode this
 *  entire phase exists to avoid triggering. */
export const MAX_AUTO_CONTACTS_PER_DAY = MAX_CONTACTOS_POR_DIA;

/** Give up on a permanently-failing number after this many attempts —
 *  same value and reasoning as recall-messaging.ts's MAX_NOTIFY_ATTEMPTS:
 *  without a bound a bad number would be retried every tick forever. */
export const MAX_AUTO_CONTACT_ATTEMPTS = 3;

/** UTC calendar day, not per-client local time — same reasoning as
 *  prospecting.ts's isNewCalendarMonth: this is a safety quota, not a
 *  client-facing report boundary. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProspectingContactCampaignInput {
  id: string;
  clientId: string;
  tenantId: string | null;
  status: string;
  consentAcknowledgedAt: Date | null;
  consentVersion: string | null;
  autoContactPausedAt: Date | null;
  /** «Nos dedicamos a …» — el {{3}} del primer mensaje. Sin ella, el primer
   *  mensaje no se envía (los seguimientos sí: no la usan). */
  presentacion: string | null;
}

export type RunProspectingContactResult =
  | { ok: true; sent: number; followedUp: number; failed: number; capReached: boolean }
  | {
      ok: false;
      error:
        | 'campaign_paused'
        | 'no_consent'
        | 'auto_paused'
        | 'no_whatsapp_connection'
        | 'quality_check_failed'
        | 'quality_degraded';
    };

/**
 * One run of one campaign's auto-contact step. Safe to call every tick —
 * the daily cap and per-lead attempt cap are re-derived from the DB each
 * time, never trusted from a timer, same posture as every other job in
 * this product.
 *
 * Fase 3.3 — atiende la secuencia entera, no solo el primer contacto:
 * dentro del cupo diario, primero los seguimientos que ya cumplieron su
 * espera y después los prospectos nuevos con lo que quede.
 */
export async function runProspectingContact(
  prisma: PrismaClient,
  campaign: ProspectingContactCampaignInput,
  now: Date = new Date(),
): Promise<RunProspectingContactResult> {
  if (campaign.status !== 'active') {
    return { ok: false, error: 'campaign_paused' };
  }
  if (!campaign.consentAcknowledgedAt || campaign.consentVersion !== PROSPECTING_CONSENT_VERSION) {
    return { ok: false, error: 'no_consent' };
  }
  if (campaign.autoContactPausedAt) {
    return { ok: false, error: 'auto_paused' };
  }

  const connection = await prisma.metaChannelConnection.findFirst({
    where: { clientId: campaign.clientId, channel: 'whatsapp', status: 'active' },
    select: {
      id: true,
      externalId: true,
      status: true,
      accessTokenCiphertext: true,
      accessTokenIv: true,
      accessTokenTag: true,
    },
  });
  const sender = metaSenderFor(connection);
  if (!sender) {
    return { ok: false, error: 'no_whatsapp_connection' };
  }

  const info = await getPhoneNumberInfo(sender.token, sender.phoneNumberId);
  if (!info.ok) {
    logError('prospecting_contact.quality_check_failed', new Error(info.error), { campaignId: campaign.id }, 'warn');
    return { ok: false, error: 'quality_check_failed' };
  }

  // Keep the stored mirror fresh as a side effect for other surfaces
  // (the operator panel reads MetaChannelConnection.qualityRating) — the
  // gate below always uses the freshly-fetched value above, never this.
  if (connection) {
    await prisma.metaChannelConnection
      .update({ where: { id: connection.id }, data: { qualityRating: info.data.quality_rating ?? null } })
      .catch(() => null);
  }

  if (info.data.quality_rating === 'YELLOW' || info.data.quality_rating === 'RED') {
    await prisma.prospectingCampaign.update({ where: { id: campaign.id }, data: { autoContactPausedAt: now } });
    logError(
      'prospecting_contact.quality_degraded',
      new Error(`quality_rating=${info.data.quality_rating}`),
      { campaignId: campaign.id },
      'warn',
    );
    return { ok: false, error: 'quality_degraded' };
  }

  // El tope diario cuenta los toques de seguimiento igual que los primeros
  // contactos: para el número del cliente, y para quien lo recibe, un
  // seguimiento es exactamente igual de "mensaje en frío" que el primero.
  const sentToday = await prisma.leadAudit.count({
    where: {
      clientId: campaign.clientId,
      action: { in: ['contacted_auto', 'followed_up_auto'] },
      changedAt: { gte: startOfUtcDay(now) },
    },
  });
  const remaining = MAX_AUTO_CONTACTS_PER_DAY - sentToday;
  if (remaining <= 0) {
    return { ok: true, sent: 0, followedUp: 0, failed: 0, capReached: true };
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: campaign.clientId },
    select: { name: true, companyName: true },
  });
  const businessName = nombreRemitente(client);

  // Los seguimientos van ANTES que los primeros contactos dentro del cupo
  // diario. Terminar una secuencia empezada vale más que empezar otra: al
  // que ya recibió un mensaje se le prometió implícitamente una cadencia, y
  // dejarla a medias por haber gastado el cupo en prospectos nuevos es
  // justo el fallo que esta fase viene a arreglar.
  //
  // La condición de "le toca ya" se arma en SQL, un OR por escalón, porque
  // cada escalón tiene su propia espera: así `take: remaining` devuelve
  // exactamente los que hay que enviar, sin filtrar en memoria un lote que
  // luego se quedaría corto.
  // Sin presentación no sale ningún paso cuyo texto la lleve: quedaría «Nos
  // dedicamos a  y…», en nombre del cliente y a un desconocido. Se normaliza
  // otra vez aquí aunque la ruta ya la guarde normalizada: es la última
  // puerta antes de WhatsApp, y un valor viejo o escrito por otro camino no
  // puede colarse.
  //
  // Hoy la llevan el primer mensaje y el primer seguimiento; el último no.
  // Un lead que se queda en el paso 2 porque el cliente vació la
  // presentación espera ahí —no se salta al 3—: saltarse un paso sería
  // mandar «última vez que te escribimos» a quien solo ha recibido uno.
  const presentacion = normalizarPresentacion(campaign.presentacion);

  const followUpDue = PROSPECTING_SEQUENCE.filter(
    (s) => s.step > 1 && (presentacion || !pasoUsaPresentacion(s.step)),
  ).map((s) => ({
    followUpCount: s.step - 1,
    lastAutoContactAt: { lte: new Date(now.getTime() - s.delayDays * DAY_MS) },
  }));

  const followUps =
    followUpDue.length === 0
      ? []
      : await prisma.lead.findMany({
          where: {
            clientId: campaign.clientId,
            source: 'outbound',
            status: 'contactado',
            // El corte: en cuanto contesta, no recibe nada más.
            repliedAt: null,
            contactPhone: { not: null },
            autoContactAttempts: { lt: MAX_AUTO_CONTACT_ATTEMPTS },
            OR: followUpDue,
          },
          // El que lleva más tiempo esperando su siguiente toque, primero.
          orderBy: { lastAutoContactAt: 'asc' },
          take: remaining,
        });

  const firstContacts =
    followUps.length >= remaining || (!presentacion && pasoUsaPresentacion(1))
      ? []
      : await prisma.lead.findMany({
          where: {
            clientId: campaign.clientId,
            source: 'outbound',
            status: 'nuevo',
            contactPhone: { not: null },
            autoContactAttempts: { lt: MAX_AUTO_CONTACT_ATTEMPTS },
          },
          orderBy: { createdAt: 'asc' },
          take: remaining - followUps.length,
        });

  // EL BLOQUEO POR TELÉFONO (28/09/2026). Hasta aquí la secuencia se
  // cortaba por LEAD, y un lead es un local de Google, no una persona. Dos
  // locales del mismo negocio comparten teléfono a menudo —
  // markProspectReplied ya lo sabía y marca los dos al responder—, pero el
  // envío no: un barrido posterior podía encontrar el segundo local de
  // quien ya había dicho «no me interesa» y empezarle la secuencia desde
  // cero. Justo lo que el seguimiento v2 promete que no pasará.
  //
  // Un primer contacto no sale a un teléfono que ya está en una secuencia,
  // que ya ha respondido o que está descartado. Ese lead deja de ser
  // candidato (se agotan sus intentos automáticos) pero sigue en la lista
  // del cliente para que decida él — salvo que el otro local dijera que no:
  // entonces se descarta también, por la misma razón que lo hace A2 en
  // prospecting-replies.ts.
  const blockers =
    firstContacts.length === 0
      ? []
      : await prisma.lead.findMany({
          where: {
            clientId: campaign.clientId,
            source: 'outbound',
            contactPhone: { not: null },
            OR: [{ followUpCount: { gt: 0 } }, { repliedAt: { not: null } }, { status: 'descartado' }],
          },
          select: { id: true, contactPhone: true, status: true, repliedAt: true },
        });
  // Los teléfonos que ya reciben algo en ESTA pasada: dos locales nuevos con
  // el mismo número en el mismo barrido no reciben dos primeros mensajes.
  const phonesThisRun: string[] = [];

  let sent = 0;
  let followedUp = 0;
  let failed = 0;
  let blocked = 0;

  for (const lead of [...followUps, ...firstContacts]) {
    const phone = lead.contactPhone;
    if (!phone) continue;

    if (lead.followUpCount === 0) {
      if (phonesThisRun.some((p) => phonesMatch(p, phone))) {
        // No se marca: si el envío del otro falla, este vuelve a ser
        // candidato. Cuando el otro salga, el bloqueo de abajo lo retira.
        continue;
      }
      const blocker = blockers.find((b) => b.id !== lead.id && phonesMatch(b.contactPhone, phone));
      if (blocker) {
        const saidNo = blocker.status === 'descartado' && blocker.repliedAt !== null;
        await prisma.$transaction(async (tx) => {
          await tx.lead.update({
            where: { id: lead.id },
            data: {
              autoContactAttempts: MAX_AUTO_CONTACT_ATTEMPTS,
              autoContactError: saidNo ? 'mismo_telefono_rechazo_el_contacto' : 'mismo_telefono_ya_contactado',
              ...(saidNo ? { status: 'descartado', discardedAt: now } : {}),
            },
          });
          if (saidNo) {
            await tx.leadAudit.create({
              data: {
                leadId: lead.id,
                clientId: campaign.clientId,
                tenantId: campaign.tenantId,
                action: 'discarded',
                statusBefore: 'nuevo',
                statusAfter: 'descartado',
                actorId: 'system:prospecting',
              },
            });
          }
        });
        blocked += 1;
        continue;
      }
    }
    phonesThisRun.push(phone);

    const step = nextSequenceStep(lead.followUpCount);
    if (!step) {
      // Secuencia agotada. No debería llegar aquí (la consulta ya lo
      // excluye), pero enviar un toque que no existe sería peor que
      // saltárselo en silencio.
      continue;
    }

    // Tantos parámetros como variables tenga el texto de ESTE paso. Meta no
    // avisa de un parámetro de más o de menos al revisar la plantilla: lo
    // rechaza al enviar (132000), mensaje a mensaje.
    const bodyParams = parametrosDelPaso(step.step, {
      prospecto: lead.contactName ?? 'equipo',
      negocio: businessName,
      presentacion,
    });

    const result = await sendTemplate(sender.token, sender.phoneNumberId, phone, {
      ...step.template,
      bodyParams,
    });

    if (result.ok) {
      const isFirst = step.step === 1;
      await prisma.$transaction(async (tx) => {
        await tx.lead.update({
          where: { id: lead.id },
          data: {
            followUpCount: step.step,
            lastAutoContactAt: now,
            autoContactError: null,
            // Solo el primer toque mueve el estado y estampa contactedAt:
            // los siguientes son el mismo contacto, continuado.
            ...(isFirst ? { status: 'contactado', contactedAt: now } : {}),
          },
        });
        await tx.leadAudit.create({
          data: {
            leadId: lead.id,
            clientId: campaign.clientId,
            tenantId: campaign.tenantId,
            action: isFirst ? 'contacted_auto' : 'followed_up_auto',
            statusBefore: isFirst ? 'nuevo' : 'contactado',
            statusAfter: 'contactado',
            actorId: 'system:prospecting',
          },
        });
      });
      if (isFirst) sent += 1;
      else followedUp += 1;
    } else {
      // Un envío fallido no gasta toque: el prospecto no ha recibido nada,
      // así que followUpCount se queda donde estaba y el escalón se
      // reintenta el tick siguiente, hasta agotar el presupuesto de fallos.
      const attempts = lead.autoContactAttempts + 1;
      await prisma.lead.update({
        where: { id: lead.id },
        data: { autoContactAttempts: attempts, autoContactError: result.error.slice(0, 500) },
      });
      logError('prospecting_contact.send_failed', new Error(result.error), { leadId: lead.id, campaignId: campaign.id }, 'warn');
      failed += 1;
    }
  }

  if (blocked > 0) {
    logError(
      'prospecting_contact.same_phone_blocked',
      new Error(`${blocked} primer(os) contacto(s) retenido(s): el teléfono ya estaba en otra secuencia`),
      { campaignId: campaign.id, blocked },
      'warn',
    );
  }

  return {
    ok: true,
    sent,
    followedUp,
    failed,
    capReached: sentToday + sent + followedUp >= MAX_AUTO_CONTACTS_PER_DAY,
  };
}
