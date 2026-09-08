import 'server-only';
import type { PrismaClient, Prisma } from '@prisma/client';
import { decryptMetaToken } from './meta-business';
import { sendMessage } from './whatsapp-api';
import { slotsFromJson, parseSlotChoice, type CallbackSlot } from './recall-slots';
import { logError } from './observability';

// =============================================================================
// Fase 3 — quien llamó contesta con un número y se le apunta la devolución.
//
// La otra mitad de recall-slots.ts: aquel decide QUÉ huecos se ofrecen,
// éste resuelve la respuesta contra los que se ofrecieron de verdad.
//
// **La confirmación NO es una plantilla.** Quien llamó acaba de
// escribirnos, así que la ventana de atención al cliente de 24 horas está
// abierta y se le puede contestar con un mensaje libre. Eso importa: la
// confirmación puede decir la hora exacta, el motivo de un cambio o pedir
// que proponga él una hora, sin pasar por aprobación de Meta. Solo la
// oferta inicial, que es la que sale en frío, necesita plantilla.
//
// La ventana de respuesta la acota `CALLBACK_REPLY_WINDOW_HOURS`: un «2»
// que llega tres días después no se refiere a unos huecos que ya pasaron.
// =============================================================================

/** Cuánto vale una oferta. Los huecos miran como mucho tres días hacia
 *  delante, así que una respuesta más tardía que esto se refiere, casi
 *  seguro, a horas que ya han pasado. */
export const CALLBACK_REPLY_WINDOW_HOURS = 24;

export type CallbackReplyOutcome =
  | { status: 'scheduled'; slot: CallbackSlot; movedFrom?: CallbackSlot }
  | { status: 'declined' }
  | { status: 'unclear' }
  | { status: 'no_slot_free' }
  | { status: 'ignored'; reason: 'no_open_offer' | 'already_chosen' };

export interface CallbackReplyInput {
  subscriptionId: string;
  from: string;
  text: string;
  now?: Date;
}

/** Igual que sameNumber en la ruta de digest: Meta manda el `wa_id` sin el
 *  '+' que nosotros guardamos, así que un === no casaría nunca. */
function sameNumber(a: string, b: string): boolean {
  const digits = (value: string) => value.replace(/\D/g, '');
  const x = digits(a);
  const y = digits(b);
  if (!x || !y) return false;
  return x === y || x.endsWith(y) || y.endsWith(x);
}

interface OfferRow {
  id: string;
  clientId: string;
  fromNumber: string | null;
  callbackOfferedSlots: Prisma.JsonValue;
  callbackOfferedAt: Date | null;
  callbackSlotAt: Date | null;
}

/**
 * Resuelve la respuesta de quien llamó contra la oferta que recibió.
 *
 * Devuelve `ignored` cuando este número no tiene ninguna oferta abierta —
 * que NO es un error: la ruta lo trata como conversación normal y la pasa
 * a quien corresponda, igual que hace con un mensaje que no es respuesta
 * al digest.
 *
 * **Nunca lanza.** Cuelga de la ruta de mensajes entrantes de WhatsApp, que
 * es también por donde el dueño contesta su digest: un fallo aquí no puede
 * llevarse por delante esa otra mitad. Ante un error se comporta como si no
 * hubiera oferta, que es la lectura segura — el mensaje sigue su camino
 * como conversación normal en vez de perderse. Misma postura que
 * markProspectReplied y retrieveKnowledge.
 */
export async function applyCallbackReply(
  prisma: PrismaClient,
  input: CallbackReplyInput,
): Promise<CallbackReplyOutcome> {
  try {
    return await resolveCallbackReply(prisma, input);
  } catch (err) {
    logError('recall_callbacks.apply_failed', err, { subscriptionId: input.subscriptionId }, 'warn');
    return { status: 'ignored', reason: 'no_open_offer' };
  }
}

async function resolveCallbackReply(
  prisma: PrismaClient,
  input: CallbackReplyInput,
): Promise<CallbackReplyOutcome> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - CALLBACK_REPLY_WINDOW_HOURS * 60 * 60_000);

  // La oferta más reciente de este número dentro de la ventana. Se filtra
  // por número en memoria porque `fromNumber` se guarda en E.164 y el
  // `wa_id` viene sin '+': una igualdad en SQL no casaría.
  const candidates = (await prisma.callEvent.findMany({
    where: {
      subscriptionId: input.subscriptionId,
      callbackOfferedAt: { gte: since },
      fromNumber: { not: null },
    },
    orderBy: { callbackOfferedAt: 'desc' },
    take: 20,
    select: {
      id: true,
      clientId: true,
      fromNumber: true,
      callbackOfferedSlots: true,
      callbackOfferedAt: true,
      callbackSlotAt: true,
    },
  })) as OfferRow[];

  const offer = candidates.find((row) => row.fromNumber && sameNumber(row.fromNumber, input.from));
  if (!offer) return { status: 'ignored', reason: 'no_open_offer' };

  // Ya eligió. No se le deja cambiar de hueco por ahora: recolocar una
  // devolución ya prometida al dueño necesita avisarle del cambio, y eso
  // es otra plantilla. Limitación conocida, escrita aquí donde se nota.
  if (offer.callbackSlotAt) return { status: 'ignored', reason: 'already_chosen' };

  const slots = slotsFromJson(offer.callbackOfferedSlots);
  if (slots.length === 0) return { status: 'ignored', reason: 'no_open_offer' };

  const choice = parseSlotChoice(input.text, slots.length);
  if (choice.kind === 'unclear') return { status: 'unclear' };
  if (choice.kind === 'none') return { status: 'declined' };

  const wanted = slots[choice.index - 1];

  // Entre que se le ofreció y que contesta, otra persona puede haberse
  // llevado ese hueco. Se comprueba ahora, no antes: la oferta es de hace
  // minutos u horas.
  const free = await firstFreeSlot(prisma, input.subscriptionId, wanted, slots, now);
  if (!free) return { status: 'no_slot_free' };

  await prisma.callEvent.update({
    where: { id: offer.id },
    data: { callbackSlotAt: free.at, callbackChosenAt: now },
  });

  return free.at.getTime() === wanted.at.getTime()
    ? { status: 'scheduled', slot: free }
    : { status: 'scheduled', slot: free, movedFrom: wanted };
}

/**
 * El hueco pedido si sigue libre; si no, el siguiente de los que se le
 * ofrecieron que lo esté.
 *
 * Recolocar dentro de la MISMA oferta y no en un hueco cualquiera es
 * deliberado: solo se le puede apuntar a una hora que él llegó a ver. Si
 * ninguna de las suyas queda libre, no se elige por él.
 */
async function firstFreeSlot(
  prisma: PrismaClient,
  subscriptionId: string,
  wanted: CallbackSlot,
  offered: readonly CallbackSlot[],
  now: Date,
): Promise<CallbackSlot | null> {
  const taken = await prisma.callEvent.findMany({
    where: { subscriptionId, callbackSlotAt: { gte: now } },
    select: { callbackSlotAt: true },
  });
  const takenMs = new Set(taken.map((row) => row.callbackSlotAt!.getTime()));

  const isUsable = (slot: CallbackSlot) => !takenMs.has(slot.at.getTime()) && slot.at.getTime() > now.getTime();

  if (isUsable(wanted)) return wanted;
  // El siguiente después del que pidió, para no moverle a una hora
  // ANTERIOR a la que eligió: adelantar una llamada sin avisar es peor
  // que retrasarla.
  return offered.find((slot) => slot.at.getTime() > wanted.at.getTime() && isUsable(slot)) ?? null;
}

// ---------------------------------------------------------------------------
// La contestación
// ---------------------------------------------------------------------------

/**
 * Qué se le responde. Pura y exportada: el texto que le llega a un
 * desconocido merece un test propio, y así no hace falta la red para
 * comprobarlo.
 */
export function callbackReplyText(outcome: CallbackReplyOutcome, businessName: string): string | null {
  switch (outcome.status) {
    case 'scheduled':
      return outcome.movedFrom
        ? `Ese hueco se acaba de ocupar, así que te hemos apuntado ${outcome.slot.label}. Si no te viene bien, dinos qué hora te encaja.`
        : `Hecho: te llamamos ${outcome.slot.label}. Si te surge algo, escríbenos por aquí.`;
    case 'declined':
      return `Sin problema. Dinos a qué hora te viene bien y te llamamos desde ${businessName}.`;
    case 'unclear':
      return 'Perdona, no te hemos entendido. Contéstanos solo con el número de la opción que prefieras (1, 2 o 3).';
    case 'no_slot_free':
      return 'Se nos han ocupado esos huecos. Dinos a qué hora te viene bien y te llamamos.';
    default:
      // 'ignored' no se contesta: no era una respuesta a nuestra oferta.
      return null;
  }
}

/**
 * Contesta por WhatsApp con un mensaje libre.
 *
 * **Nunca lanza.** La devolución ya quedó apuntada en la base de datos
 * antes de llegar aquí; que falle el acuse no puede deshacer eso ni tumbar
 * la ruta. Se registra y se sigue.
 */
export async function sendCallbackReply(
  prisma: PrismaClient,
  input: { clientId: string; to: string; text: string },
): Promise<{ ok: boolean }> {
  try {
    const connection = await prisma.metaChannelConnection.findFirst({
      where: { clientId: input.clientId, channel: 'whatsapp', status: 'active' },
      select: {
        externalId: true,
        accessTokenCiphertext: true,
        accessTokenIv: true,
        accessTokenTag: true,
      },
    });
    if (!connection) return { ok: false };

    const token = decryptMetaToken({
      ciphertext: connection.accessTokenCiphertext,
      iv: connection.accessTokenIv,
      tag: connection.accessTokenTag,
    });

    const sent = await sendMessage(token, connection.externalId, input.to, input.text);
    return { ok: sent.ok };
  } catch (err) {
    logError('recall_callbacks.reply_failed', err, { clientId: input.clientId }, 'warn');
    return { ok: false };
  }
}
