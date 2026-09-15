import 'server-only';
import type { GoogleBusinessConnection, PrismaClient } from '@prisma/client';
import { createCampaignWithRequests, isAddressable, type CampaignRecipientInput } from './review-request-campaign';
import { isProductContracted } from './client-product-access';
import { hasLeadsInboxAccess } from './leads';
import { logError } from './observability';

// =============================================================================
// Fase 5 — invitar a reseñar a los leads que el cliente marca 'convertido'.
//
// La TERCERA fuente de destinatarios para una maquinaria que ya existía.
// Las otras dos:
//
//   1. El formulario manual de /portal/resenas — el cliente pega correos.
//   2. 'recall' (recall-reviews.ts) — el dueño contesta al resumen diario
//      por WhatsApp diciendo qué llamadas acabaron en trabajo.
//
// Las tres terminan en la misma llamada a createCampaignWithRequests, así
// que las campañas de aquí aparecen en las mismas pantallas y comparten
// el enlace /r/{id}, el recordatorio único y los reintentos, sin tocar
// nada de eso. Este archivo solo decide A QUIÉN invitar.
//
// ---------------------------------------------------------------------
// EL DISPARADOR ES 'CONVERTIDO', NUNCA LA SATISFACCIÓN
// ---------------------------------------------------------------------
// review-request-campaign.ts lo dice de sí mismo: no tiene ningún
// concepto de la experiencia previa del destinatario, y eso es
// deliberado — filtrar por satisfacción (review gating) va contra la
// política de Google. Este archivo mantiene esa propiedad: pregunta si
// el lead SE CONVIRTIÓ EN CLIENTE, que es un hecho comercial, no si
// quedó contento, que es una opinión que además no tenemos.
//
// Es exactamente la misma semántica que la pregunta que 'recall' le hace
// al dueño («¿a quién atendiste?»), y por el mismo motivo.
// =============================================================================

/** Cuánto puede haber pasado desde la conversión para que la invitación
 *  siga teniendo sentido. Mismo razonamiento que recall-reviews.ts hace
 *  para su propio recordatorio: pasada una semana, pedir la reseña deja
 *  de tener que ver con algo que el cliente final recuerde. */
export const LEAD_FRESHNESS_DAYS = 7;

/** Periodo de gracia por destinatario y cliente. Sin esto, un cliente
 *  final que vuelve a comprar cada trimestre recibiría una invitación
 *  cada trimestre — y como ya dejó su reseña la primera vez, las demás
 *  son spam puro.
 *
 *  Un año y no "para siempre" porque una reseña de hace dos años ya no
 *  representa al negocio, y volver a pedirla entonces es legítimo. */
export const RECIPIENT_COOLDOWN_DAYS = 365;

/** Tope por barrido y por conexión, alineado con el del formulario
 *  manual: createCampaignWithRequests envía de forma síncrona, así que
 *  este número es también el techo de duración de un tick. */
export const MAX_LEADS_PER_SWEEP = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LeadRecipientSource {
  id: string;
  contactName: string | null;
  contactEmail: string | null;
}

/**
 * A qué dirección se invita a este lead, si es que se puede.
 *
 * **Solo correo, y es una limitación consciente, no un olvido.** El canal
 * de WhatsApp existe y funciona (lo usa 'recall'), pero su plantilla
 * `recall_review_request` se envía a Meta bajo la WABA del producto
 * 'recall': un cliente que tenga 'reviews' + 'leads' y no 'recall' no
 * tiene remitente de Meta con el que mandarla. Cuando exista una
 * plantilla propia, este es el único punto que hay que tocar.
 *
 * Pura: sin red, sin base de datos.
 */
export function pickRecipient(lead: LeadRecipientSource): CampaignRecipientInput | null {
  const email = lead.contactEmail?.trim().toLowerCase() ?? '';
  if (!email || !isAddressable('email', email)) return null;
  const name = lead.contactName?.trim();
  return { recipient: email, name: name && name.length > 0 ? name : null };
}

export interface LeadReviewSweepResult {
  connectionsScanned: number;
  campaignsCreated: number;
  invited: number;
  /** Leads mirados y descartados. Se sellan igual: ver reviewRequestedAt. */
  skippedNoAddress: number;
  skippedCooldown: number;
  failed: { clientId: string; error: string }[];
}

/**
 * Un barrido completo.
 *
 * **Nunca lanza.** Vive dentro del tick de reseñas, junto a la
 * sincronización con Google: un fallo aquí no puede dejar sin sincronizar
 * las reseñas de todos los clientes. Cada conexión está aislada de las
 * demás por el mismo motivo.
 *
 * Seguro de llamar más veces de las que hace falta, que es exactamente lo
 * que va a pasar: la elegibilidad se recalcula en cada llamada contra
 * `reviewRequestedAt`, no contra la cadencia del scheduler.
 */
export async function sweepReviewRequestsFromLeads(
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<LeadReviewSweepResult> {
  const now = opts.now ?? new Date();
  const result: LeadReviewSweepResult = {
    connectionsScanned: 0,
    campaignsCreated: 0,
    invited: 0,
    skippedNoAddress: 0,
    skippedCooldown: 0,
    failed: [],
  };

  const connections = await prisma.googleBusinessConnection.findMany({
    where: { autoRequestFromLeads: true, status: 'active' },
    // Un cliente con varios locales puede tener el interruptor en más de
    // uno, y un lead convertido NO pertenece a ninguno en concreto: no
    // hay nada en el modelo Lead que lo ate a una ubicación. Se ordena
    // por antigüedad de conexión para que el reparto sea determinista y
    // el lead caiga siempre en el local más antiguo (el principal, en la
    // práctica). El segundo local no recibe nada porque el sellado de
    // reviewRequestedAt del primero ya lo ha sacado de la consulta —
    // esta secuencialidad es lo que evita la doble invitación, así que
    // no conviertas este bucle en un Promise.all.
    orderBy: { connectedAt: 'asc' },
  });

  for (const connection of connections) {
    result.connectionsScanned += 1;
    try {
      const outcome = await sweepConnection(prisma, connection, now);
      result.campaignsCreated += outcome.campaignsCreated;
      result.invited += outcome.invited;
      result.skippedNoAddress += outcome.skippedNoAddress;
      result.skippedCooldown += outcome.skippedCooldown;
    } catch (err) {
      logError('review_requests_from_leads.connection_failed', err, { clientId: connection.clientId }, 'warn');
      result.failed.push({
        clientId: connection.clientId,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  return result;
}

async function sweepConnection(
  prisma: PrismaClient,
  connection: GoogleBusinessConnection,
  now: Date,
): Promise<Omit<LeadReviewSweepResult, 'connectionsScanned' | 'failed'>> {
  const empty = { campaignsCreated: 0, invited: 0, skippedNoAddress: 0, skippedCooldown: 0 };

  // El interruptor puede sobrevivir a la baja del producto: es una
  // columna de la conexión, y cancelar 'reviews' no la apaga. Se
  // comprueba en cada barrido, no al activarlo.
  const [hasReviews, hasInbox] = await Promise.all([
    isProductContracted(prisma, connection.clientId, 'reviews'),
    hasLeadsInboxAccess(prisma, connection.clientId),
  ]);
  if (!hasReviews || !hasInbox) return empty;

  const freshnessCutoff = new Date(now.getTime() - LEAD_FRESHNESS_DAYS * DAY_MS);
  const leads = await prisma.lead.findMany({
    where: {
      clientId: connection.clientId,
      status: 'convertido',
      convertedAt: { gte: freshnessCutoff },
      reviewRequestedAt: null,
    },
    select: { id: true, contactName: true, contactEmail: true },
    orderBy: { convertedAt: 'asc' },
    take: MAX_LEADS_PER_SWEEP,
  });
  if (leads.length === 0) return empty;

  // Los que no tienen dirección utilizable se sellan igual: el intento se
  // hizo, y dejarlos sin sellar los haría volver en cada tick hasta que
  // se cayeran de la ventana de frescura, sin que nada pudiera cambiar
  // entre medias.
  const addressable: { leadId: string; recipient: CampaignRecipientInput }[] = [];
  const unusableIds: string[] = [];
  for (const lead of leads) {
    const recipient = pickRecipient(lead);
    if (recipient) addressable.push({ leadId: lead.id, recipient });
    else unusableIds.push(lead.id);
  }

  const cooldownIds = await recentlyInvited(
    prisma,
    connection.clientId,
    addressable.map((a) => a.recipient.recipient),
    now,
  );
  const toInvite = addressable.filter((a) => !cooldownIds.has(a.recipient.recipient));
  const cooledDown = addressable.filter((a) => cooldownIds.has(a.recipient.recipient));

  // Sellar antes de enviar sería mentir sobre lo que ocurrió, pero estos
  // dos grupos no dependen del envío: ya están decididos.
  const decidedIds = [...unusableIds, ...cooledDown.map((a) => a.leadId)];
  if (decidedIds.length > 0) await stampRequested(prisma, decidedIds, now);

  if (toInvite.length === 0) {
    return { ...empty, skippedNoAddress: unusableIds.length, skippedCooldown: cooledDown.length };
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: connection.clientId },
    select: { name: true, companyName: true },
  });
  const businessName = client?.companyName ?? client?.name ?? connection.locationName;

  const created = await createCampaignWithRequests({
    connection,
    businessName,
    // Fechada, igual que las de 'recall': quien mire la lista de campañas
    // necesita saber de qué día es cada una, no de qué cliente (que ya lo
    // sabe por dónde está mirando).
    campaignName: `Clientes convertidos ${now.toISOString().slice(0, 10)}`,
    // El lead pasó a 'convertido': existe relación comercial. Es el mismo
    // fundamento que usa 'recall' para alguien a quien el negocio atendió.
    consentBasis: 'customer_relationship',
    recipients: toInvite.map((a) => a.recipient),
    channel: 'email',
  });

  if (!created.ok) {
    // 'no_review_url' es transitorio de verdad: la ficha de Google puede
    // no haber devuelto todavía el enlace. Estos leads NO se sellan, así
    // que vuelven al siguiente tick y se caen solos al salir de la
    // ventana de frescura si el problema no se arregla.
    logError(
      'review_requests_from_leads.campaign_failed',
      new Error(created.error),
      { clientId: connection.clientId, connectionId: connection.id },
      'warn',
    );
    return { ...empty, skippedNoAddress: unusableIds.length, skippedCooldown: cooledDown.length };
  }

  await stampRequested(prisma, toInvite.map((a) => a.leadId), now);

  return {
    campaignsCreated: 1,
    // Lo que se registró como invitación, no lo que Resend confirmó: un
    // envío fallido ya tiene su fila en 'failed' y su propio reintento.
    invited: toInvite.length,
    skippedNoAddress: unusableIds.length,
    skippedCooldown: cooledDown.length,
  };
}

/**
 * Cuáles de estos destinatarios ya recibieron una invitación de ESTE
 * cliente dentro del periodo de gracia.
 *
 * Mira todas las campañas del cliente, no solo las automáticas: si el
 * dueño ya le pidió la reseña a mano la semana pasada, volver a pedírsela
 * porque además el lead figura como convertido es la misma molestia.
 */
async function recentlyInvited(
  prisma: PrismaClient,
  clientId: string,
  recipients: readonly string[],
  now: Date,
): Promise<Set<string>> {
  if (recipients.length === 0) return new Set();
  const cutoff = new Date(now.getTime() - RECIPIENT_COOLDOWN_DAYS * DAY_MS);
  const rows = await prisma.reviewRequest.findMany({
    where: {
      recipient: { in: [...recipients] },
      createdAt: { gte: cutoff },
      campaign: { clientId },
    },
    select: { recipient: true },
  });
  return new Set(rows.map((r) => r.recipient));
}

async function stampRequested(prisma: PrismaClient, leadIds: readonly string[], now: Date): Promise<void> {
  await prisma.lead.updateMany({
    where: { id: { in: [...leadIds] } },
    data: { reviewRequestedAt: now },
  });
}
