import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from './observability';
import { getChatbotMessageCaps, capForTier } from './chatbot-settings';

// =============================================================================
// Chatbot — cuánto lleva gastado este chatbot este mes, y si le queda margen.
//
// Se consulta UNA vez por mensaje, justo antes de llamar al modelo y después
// de descartar los casos que no gastan (una persona atendiendo la
// conversación). Cuenta mensajes CONTESTADOS por el bot, no mensajes
// recibidos: lo que cuesta dinero es la llamada al modelo, y el turno del
// cliente se guarda igual aunque no haya respuesta.
//
// El reinicio del mes es perezoso, igual que en prospecting.ts: no hay cron
// que ponga contadores a cero: cuando llega el primer mensaje de un mes
// nuevo, la fila se reinicia sola. Un cron para esto sería otra cosa que
// mantener y otra que puede no ejecutarse.
//
// No es atómico frente a dos mensajes simultáneos del mismo chatbot: dos
// turnos a la vez pueden colarse uno por encima del tope. Aceptado a
// propósito —el mismo criterio que el contador de prospección—: el tope
// protege de un bucle o un abuso de miles de mensajes, y pasarse por uno no
// cambia nada de lo que el tope existe para evitar.
// =============================================================================

export interface ChatbotAllowanceInput {
  clientProductId: string;
  clientId: string;
  tenantId: string | null;
  tier: string | null;
}

export type ChatbotAllowance =
  | { allowed: true; used: number; cap: number }
  | { allowed: false; used: number; cap: number };

/** UTC, no la zona del cliente: esto es una cuota de coste, no un informe. */
function isNewCalendarMonth(usageResetAt: Date, now: Date): boolean {
  return usageResetAt.getUTCFullYear() !== now.getUTCFullYear() || usageResetAt.getUTCMonth() !== now.getUTCMonth();
}

/**
 * Apunta un mensaje contestado y dice si se podía. Cuando devuelve
 * `allowed: false` NO ha incrementado nada: el tope ya estaba alcanzado.
 *
 * Nunca lanza. Si la consulta falla, deja pasar el mensaje y lo registra: un
 * fallo del contador no debe dejar mudo al bot de un cliente que paga. El
 * tope protege de un gasto desbocado, y un desbocado no empieza con un
 * error de base de datos.
 */
export async function consumeMessageAllowance(
  prisma: PrismaClient,
  input: ChatbotAllowanceInput,
  now: Date = new Date(),
): Promise<ChatbotAllowance> {
  try {
    const caps = await getChatbotMessageCaps();
    const existing = await prisma.chatbotUsage.findUnique({
      where: { clientProductId: input.clientProductId },
      select: { id: true, messagesThisMonth: true, usageResetAt: true, capOverride: true },
    });

    const cap = existing?.capOverride ?? capForTier(input.tier, caps);

    if (!existing) {
      await prisma.chatbotUsage.create({
        data: {
          clientProductId: input.clientProductId,
          clientId: input.clientId,
          tenantId: input.tenantId,
          messagesThisMonth: 1,
          usageResetAt: now,
        },
      });
      return { allowed: true, used: 1, cap };
    }

    if (isNewCalendarMonth(existing.usageResetAt, now)) {
      await prisma.chatbotUsage.update({
        where: { id: existing.id },
        data: { messagesThisMonth: 1, usageResetAt: now },
      });
      return { allowed: true, used: 1, cap };
    }

    if (existing.messagesThisMonth >= cap) {
      return { allowed: false, used: existing.messagesThisMonth, cap };
    }

    const updated = await prisma.chatbotUsage.update({
      where: { id: existing.id },
      data: { messagesThisMonth: { increment: 1 } },
      select: { messagesThisMonth: true },
    });
    return { allowed: true, used: updated.messagesThisMonth, cap };
  } catch (err) {
    logError('chatbot_usage.consume_failed', err, { clientProductId: input.clientProductId }, 'warn');
    return { allowed: true, used: 0, cap: 0 };
  }
}

/** Lo consumido hasta ahora, para enseñarlo. No toca el contador. */
export async function readMessageUsage(
  prisma: PrismaClient,
  clientProductId: string,
  tier: string | null,
  now: Date = new Date(),
): Promise<{ used: number; cap: number }> {
  const caps = await getChatbotMessageCaps();
  const row = await prisma.chatbotUsage.findUnique({
    where: { clientProductId },
    select: { messagesThisMonth: true, usageResetAt: true, capOverride: true },
  });
  const cap = row?.capOverride ?? capForTier(tier, caps);
  if (!row || isNewCalendarMonth(row.usageResetAt, now)) return { used: 0, cap };
  return { used: row.messagesThisMonth, cap };
}
