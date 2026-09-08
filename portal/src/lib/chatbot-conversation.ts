import 'server-only';
import type { PrismaClient, Prisma } from '@prisma/client';
import { buildChatbotContext } from './chatbot-config';
import { generateBotReply, type ConversationTurn } from './chatbot-reply-ai';
import { retrieveKnowledge } from './chatbot-knowledge';
import { botShouldReply } from './chatbot-handoff';

// =============================================================================
// Fase 1.2 — orquestación de un turno de conversación.
//
// Junta las tres piezas: la configuración aprobada del wizard
// (chatbot-config.ts), el motor (chatbot-reply-ai.ts) y el transcript. Las
// cinco rutas /api/internal/channels/*\/reply son envoltorios finos sobre
// esto: cada una resuelve su cliente desde el identificador de su
// plataforma y delega aquí, para que no vuelva a haber cinco copias de la
// misma lógica como pasaba con /context antes de la Fase 1.1.
//
// Los dos turnos (el del cliente y el del bot) se escriben en UNA sola
// operación, al final. Así no puede quedar a medias si el modelo falla, y
// no hay dos escrituras compitiendo por la misma fila.
//
// Si el modelo falla o no hay clave, el turno del CLIENTE se guarda igual:
// el portal es el sistema de registro, y perder lo que dijo una persona
// porque nuestra IA estaba caída sería el peor de los fallos posibles.
// =============================================================================

/** Cómo se identifica la conversación en curso. Dos estrategias, porque
 *  los canales son distintos de verdad:
 *
 *   • 'exact' — el widget web genera su propio id de sesión por pageview y
 *     lo manda en cada mensaje; la fila se identifica por él.
 *   • 'inactivity' — en WhatsApp/Telegram/Messenger/Instagram el
 *     identificador (el número o el chat) es estable para siempre, así que
 *     la conversación se corta por inactividad: pasadas 6 horas sin
 *     actividad, el siguiente mensaje abre una conversación nueva.
 *
 *  Es la misma convención que ya usan las rutas /message; aquí está en un
 *  solo sitio. */
export type ConversationKey =
  | { kind: 'exact'; externalSessionId: string }
  | { kind: 'inactivity'; sessionPrefix: string };

const INACTIVITY_MS = 6 * 60 * 60_000;

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface ReplyToIncomingMessageInput {
  clientId: string;
  tenantId: string | null;
  key: ConversationKey;
  /** Canal de origen, tal y como se guarda en Lead.channel. */
  channel: string;
  message: string;
  now?: Date;
}

export type ReplyToIncomingMessageResult =
  | { ok: true; conversationId: string; reply: string; escalate: boolean; escalateReason: string | null }
  | { ok: true; skipped: true; reason: 'no_api_key'; conversationId: string }
  /** Fase 3 — una persona tiene esta conversación. El turno del cliente
   *  queda guardado, pero no hay respuesta que entregar: contesta el
   *  humano desde el portal. Quien llama (n8n) no debe enviar nada. */
  | { ok: true; skipped: true; reason: 'human_handoff'; conversationId: string }
  | { ok: false; error: string; conversationId: string };

interface ExistingConversation {
  id: string;
  startedAt: Date;
  duration: number | null;
  outcome: string | null;
  transcript: Prisma.JsonValue;
  // Fase 3 — el estado del traspaso decide si el bot puede hablar.
  handoffRequestedAt: Date | null;
  handoffTakenAt: Date | null;
  handoffClosedAt: Date | null;
}

/** Turnos legibles a partir del transcript guardado, que es un Json libre
 *  ("message list, metadata, tool calls, etc." según el esquema): lo que no
 *  tenga forma de turno se ignora en vez de romper la respuesta. */
export function readTranscriptTurns(transcript: Prisma.JsonValue | null): ConversationTurn[] {
  if (!Array.isArray(transcript)) return [];
  const turns: ConversationTurn[] = [];
  for (const entry of transcript) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const { role, content } = entry as Record<string, unknown>;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue;
    turns.push({ role, content });
  }
  return turns;
}

/**
 * Quita el turno del cliente que quedó "colgando" de un intento anterior
 * fallido, cuando este mensaje es exactamente ese mismo.
 *
 * Cuando el modelo falla, el turno del cliente sí se guarda (ver la
 * cabecera de este archivo), así que un reintento de n8n con el MISMO
 * mensaje lo duplicaría — encontrado en real el 2026-09-07, con "Sí, quiero
 * reservar" apareciendo dos veces seguidas en el transcript.
 *
 * La condición es estrecha a propósito: solo cuenta si el ÚLTIMO apunte es
 * un turno de cliente idéntico, es decir, uno que nunca llegó a recibir
 * respuesta. Si el bot ya contestó, el último apunte es suyo, y entonces un
 * "sí" repetido por la persona se conserva como lo que es: otro mensaje.
 */
export function dropDanglingRetry(entries: unknown[], message: string): unknown[] {
  const last = entries[entries.length - 1];
  if (!last || typeof last !== 'object' || Array.isArray(last)) return entries;
  const { role, content } = last as Record<string, unknown>;
  return role === 'user' && content === message ? entries.slice(0, -1) : entries;
}

async function findOpenConversation(
  prisma: PrismaClient,
  clientId: string,
  key: ConversationKey,
  now: Date,
): Promise<ExistingConversation | null> {
  const select = {
    id: true,
    startedAt: true,
    duration: true,
    outcome: true,
    transcript: true,
    handoffRequestedAt: true,
    handoffTakenAt: true,
    handoffClosedAt: true,
  };

  if (key.kind === 'exact') {
    return prisma.chatbotConversation.findUnique({
      where: { clientId_externalSessionId: { clientId, externalSessionId: key.externalSessionId } },
      select,
    });
  }

  const latest = await prisma.chatbotConversation.findFirst({
    where: { clientId, externalSessionId: { startsWith: key.sessionPrefix } },
    orderBy: { startedAt: 'desc' },
    select,
  });
  if (!latest) return null;

  const lastActivityMs = latest.startedAt.getTime() + (latest.duration ?? 0) * 1000;
  return now.getTime() - lastActivityMs <= INACTIVITY_MS ? latest : null;
}

/**
 * Un turno completo: lee la conversación abierta, genera la respuesta con
 * la configuración aprobada del cliente y guarda ambos turnos.
 *
 * `escalate` se traduce a `outcome: 'escalated'` en la propia fila: es el
 * gancho del que colgará la bandeja de traspaso a humano (Fase 3), y
 * dejarlo puesto ahora no cuesta nada.
 */
export async function replyToIncomingMessage(
  prisma: PrismaClient,
  input: ReplyToIncomingMessageInput,
): Promise<ReplyToIncomingMessageResult> {
  const now = input.now ?? new Date();
  const existing = await findOpenConversation(prisma, input.clientId, input.key, now);

  const priorTranscript = dropDanglingRetry(
    Array.isArray(existing?.transcript) ? [...(existing!.transcript as unknown[])] : [],
    input.message,
  );
  const history = readTranscriptTurns(priorTranscript as Prisma.JsonValue);

  const userEntry: TranscriptEntry = { role: 'user', content: input.message, at: now.toISOString() };

  // Fase 3 — si una persona tiene la conversación, el bot se calla. El
  // turno del cliente se guarda igual: perder lo que dijo alguien porque
  // hay un humano atendiendo sería el mismo fallo que perderlo porque
  // falló la IA. Va ANTES de llamar al modelo para no gastar la llamada.
  if (existing && !botShouldReply(existing)) {
    const conversationId = await persist(
      prisma,
      input,
      existing,
      [...priorTranscript, userEntry],
      existing.outcome,
      null,
      now,
    );
    return { ok: true, skipped: true, reason: 'human_handoff', conversationId };
  }

  // Fase 3 — la configuración y el material relevante se piden a la vez:
  // son dos consultas independientes y encadenarlas solo añadiría latencia
  // a un turno de conversación que una persona está esperando.
  // retrieveKnowledge nunca lanza; sin base de conocimiento devuelve [].
  const [context, knowledge] = await Promise.all([
    buildChatbotContext(prisma, input.clientId),
    retrieveKnowledge(prisma, input.clientId, input.message),
  ]);

  const generated = await generateBotReply({
    businessName: context.businessName,
    config: context.config,
    history,
    message: input.message,
    now,
    knowledge,
  });

  const entries: unknown[] = [...priorTranscript, userEntry];
  let outcome: string | null = existing?.outcome ?? null;
  // Fase 3 — se estampa la PRIMERA vez que escala y no se vuelve a tocar:
  // es "desde cuándo espera esta conversación a una persona", y la bandeja
  // ordena por ese dato. Reescribirlo en cada turno haría que la que lleva
  // más tiempo esperando pareciera la más reciente.
  let handoffRequestedAt: Date | null = existing?.handoffRequestedAt ?? null;

  if (generated.ok && !('skipped' in generated)) {
    entries.push({ role: 'assistant', content: generated.reply, at: now.toISOString() } satisfies TranscriptEntry);
    if (generated.escalate) {
      outcome = 'escalated';
      handoffRequestedAt ??= now;
    }
  }

  const conversationId = await persist(prisma, input, existing, entries, outcome, handoffRequestedAt, now);

  if ('skipped' in generated) {
    return { ok: true, skipped: true, reason: generated.reason, conversationId };
  }
  if (!generated.ok) {
    return { ok: false, error: generated.error, conversationId };
  }
  return {
    ok: true,
    conversationId,
    reply: generated.reply,
    escalate: generated.escalate,
    escalateReason: generated.escalateReason,
  };
}

async function persist(
  prisma: PrismaClient,
  input: ReplyToIncomingMessageInput,
  existing: ExistingConversation | null,
  entries: unknown[],
  outcome: string | null,
  handoffRequestedAt: Date | null,
  now: Date,
): Promise<string> {
  if (existing) {
    const updated = await prisma.chatbotConversation.update({
      where: { id: existing.id },
      data: {
        duration: Math.max(0, Math.round((now.getTime() - existing.startedAt.getTime()) / 1000)),
        outcome,
        handoffRequestedAt,
        // Fase 1.5 — también al actualizar, para que una conversación
        // abierta antes de que existiera el campo se rellene sola.
        channel: input.channel,
        transcript: entries as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return updated.id;
  }

  const externalSessionId =
    input.key.kind === 'exact' ? input.key.externalSessionId : `${input.key.sessionPrefix}${now.getTime()}`;

  const created = await prisma.chatbotConversation.create({
    data: {
      clientId: input.clientId,
      tenantId: input.tenantId,
      externalSessionId,
      channel: input.channel,
      startedAt: now,
      duration: 0,
      outcome,
      handoffRequestedAt,
      transcript: entries as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return created.id;
}
