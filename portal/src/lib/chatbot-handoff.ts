import 'server-only';
import type { PrismaClient, Prisma } from '@prisma/client';
import { decryptMetaToken } from './meta-business';
import { decryptChannelCredential } from './channel-crypto';
import { sendMessage as sendWhatsapp } from './whatsapp-api';
import { sendMessage as sendTelegram } from './telegram-api';
import { sendMessage as sendMessenger } from './messenger-api';
import { sendMessage as sendInstagram } from './instagram-api';
import { logError } from './observability';

// =============================================================================
// Fase 3 — bandeja de traspaso a humano: el envío saliente.
//
// El paso 7 del wizard define desde el principio cuándo derivar a una
// persona, y el motor marca la conversación... pero esa persona no tenía
// dónde retomarla. Esto es el destino que faltaba: una respuesta escrita
// desde el portal sale por el canal por el que llegó el cliente.
//
// **De dónde sale el destinatario.** No de un campo: del propio
// `externalSessionId`, que las rutas /reply y /message construyen como
// `<canal>-<identificador>-<timestamp>` (ver chatbot-conversation.ts). Es
// el mismo identificador que la plataforma usó para entregarnos el mensaje,
// así que es exactamente al que hay que contestar. Se parsea en vez de
// duplicarlo en una columna nueva para que no puedan divergir.
//
// **El canal web no puede recibir respuesta y eso es una limitación real.**
// Los otros cuatro tienen una API a la que llamar; el widget web es una
// página que ya se cerró. No hay a dónde enviar. Se dice en la interfaz en
// vez de dejar un botón que falla.
// =============================================================================

export const HANDOFF_CHANNELS = ['whatsapp', 'telegram', 'messenger', 'instagram'] as const;
export type HandoffChannel = (typeof HANDOFF_CHANNELS)[number];

export function isHandoffChannel(channel: string | null): channel is HandoffChannel {
  return channel !== null && (HANDOFF_CHANNELS as readonly string[]).includes(channel);
}

/**
 * El identificador al que contestar, sacado del externalSessionId.
 *
 * Formato: `<canal>-<identificador>-<timestamp>`. El identificador puede
 * contener guiones (un id de Messenger no, pero no hay por qué asumirlo),
 * así que se quita el prefijo del canal por delante y el timestamp por
 * detrás en vez de partir por guiones.
 *
 * Pura y exportada: es la pieza que se rompe si algún día cambia el formato
 * de sesión, y romperla significa contestarle a otra persona.
 */
export function parseRecipient(channel: string, externalSessionId: string | null): string | null {
  if (!externalSessionId) return null;
  const prefix = `${channel}-`;
  if (!externalSessionId.startsWith(prefix)) return null;

  const rest = externalSessionId.slice(prefix.length);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash <= 0) return null;

  // Lo de detrás del último guion es el timestamp que añade la propia
  // ruta. Si no es un número, este id no lo generamos nosotros y no se
  // adivina a quién pertenece.
  const tail = rest.slice(lastDash + 1);
  if (!/^\d+$/.test(tail)) return null;

  const recipient = rest.slice(0, lastDash);
  return recipient.length > 0 ? recipient : null;
}

export type SendAgentMessageResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | 'conversation_not_found'
        | 'channel_not_supported'
        | 'no_recipient'
        | 'no_connection'
        | 'send_failed';
      detail?: string;
    };

interface ConversationRow {
  id: string;
  clientId: string;
  channel: string | null;
  externalSessionId: string | null;
  startedAt: Date;
  transcript: Prisma.JsonValue;
}

/**
 * Envía por el canal del cliente y deja el turno en el transcript.
 *
 * Primero se envía y solo después se guarda: al revés, un fallo de la
 * plataforma dejaría en el historial un mensaje que el cliente final nunca
 * recibió — y quien lo escribió creería que sí llegó. Perder el registro de
 * un envío que sí salió sería peor, pero eso solo puede pasar si la
 * escritura falla justo después, que es mucho menos probable que un envío
 * rechazado por Meta.
 */
export async function sendAgentMessage(
  prisma: PrismaClient,
  input: { conversationId: string; clientId: string; text: string; agentEmail: string; now?: Date },
): Promise<SendAgentMessageResult> {
  const now = input.now ?? new Date();

  const conversation = (await prisma.chatbotConversation.findFirst({
    where: { id: input.conversationId, clientId: input.clientId },
    select: { id: true, clientId: true, channel: true, externalSessionId: true, startedAt: true, transcript: true },
  })) as ConversationRow | null;

  if (!conversation) return { ok: false, error: 'conversation_not_found' };
  if (!isHandoffChannel(conversation.channel)) return { ok: false, error: 'channel_not_supported' };

  const recipient = parseRecipient(conversation.channel, conversation.externalSessionId);
  if (!recipient) return { ok: false, error: 'no_recipient' };

  const delivery = await deliver(prisma, conversation.clientId, conversation.channel, recipient, input.text);
  if (!delivery.ok) return delivery;

  const entries = Array.isArray(conversation.transcript) ? [...(conversation.transcript as unknown[])] : [];
  entries.push({
    // 'assistant' porque desde el lado del cliente final es la misma voz
    // del negocio, y porque así el motor lo lee como turno propio si la
    // conversación vuelve al bot. `by` es metadato: quien lee turnos lo
    // ignora, y la vista del portal lo usa para distinguirlo.
    role: 'assistant',
    content: input.text,
    at: now.toISOString(),
    by: 'agent',
    agentEmail: input.agentEmail,
  });

  await prisma.chatbotConversation.update({
    where: { id: conversation.id },
    data: {
      transcript: entries as Prisma.InputJsonValue,
      duration: Math.max(0, Math.round((now.getTime() - conversation.startedAt.getTime()) / 1000)),
    },
  });

  return { ok: true };
}

async function deliver(
  prisma: PrismaClient,
  clientId: string,
  channel: HandoffChannel,
  recipient: string,
  text: string,
): Promise<SendAgentMessageResult> {
  try {
    if (channel === 'telegram') {
      const connection = await prisma.telegramConnection.findFirst({
        where: { clientId, status: 'active' },
      });
      if (!connection) return { ok: false, error: 'no_connection' };
      const token = decryptChannelCredential({
        ciphertext: connection.botTokenCiphertext,
        iv: connection.botTokenIv,
        tag: connection.botTokenTag,
      });
      const result = await sendTelegram(token, recipient, text);
      return result.ok ? { ok: true } : { ok: false, error: 'send_failed', detail: result.error };
    }

    const connection = await prisma.metaChannelConnection.findFirst({
      where: { clientId, channel, status: 'active' },
    });
    if (!connection) return { ok: false, error: 'no_connection' };

    const token = decryptMetaToken({
      ciphertext: connection.accessTokenCiphertext,
      iv: connection.accessTokenIv,
      tag: connection.accessTokenTag,
    });

    const result =
      channel === 'whatsapp'
        ? await sendWhatsapp(token, connection.externalId, recipient, text)
        : channel === 'messenger'
          ? await sendMessenger(token, connection.externalId, recipient, text)
          : await sendInstagram(token, connection.externalId, recipient, text);

    return result.ok ? { ok: true } : { ok: false, error: 'send_failed', detail: result.error };
  } catch (err) {
    logError('chatbot_handoff.deliver_failed', err, { clientId, channel }, 'warn');
    return { ok: false, error: 'send_failed', detail: err instanceof Error ? err.message : 'unknown_error' };
  }
}

// ---------------------------------------------------------------------------
// El estado, derivado — puro
// ---------------------------------------------------------------------------

export type HandoffState = 'none' | 'pending' | 'taken' | 'closed';

export interface HandoffTimestamps {
  handoffRequestedAt?: Date | null;
  handoffTakenAt?: Date | null;
  handoffClosedAt?: Date | null;
}

/** Una sola definición del estado para las tres superficies que lo
 *  preguntan (la lista, el detalle y el motor). Repetir el `if` en cada una
 *  es exactamente cómo divergen.
 *
 *  Los campos son opcionales y se comparan con `== null` a propósito: una
 *  fila leída sin estas columnas (una conversación anterior a la Fase 3,
 *  una consulta con otro `select`) tiene que leerse como "sin traspaso",
 *  no como un estado inventado que dejaría al bot mudo. */
export function handoffState(row: HandoffTimestamps): HandoffState {
  if (row.handoffRequestedAt == null) return 'none';
  if (row.handoffClosedAt != null) return 'closed';
  if (row.handoffTakenAt != null) return 'taken';
  return 'pending';
}

/** ¿Puede contestar el bot? Solo se calla cuando una persona tiene la
 *  conversación en la mano. Ver el comentario del modelo en schema.prisma
 *  para por qué 'pending' NO silencia al bot. */
export function botShouldReply(row: HandoffTimestamps): boolean {
  return handoffState(row) !== 'taken';
}
