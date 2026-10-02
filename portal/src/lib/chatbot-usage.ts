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
//
// Packs de uso (plan de precios del 01/10/2026): cuando se acaba el cupo del
// mes, el bot sigue contestando con cargo a packMessagesRemaining, que no
// caduca. Ese descuento SÍ es atómico (updateMany condicionado a que quede
// saldo): es dinero que el cliente pagó, y dos mensajes a la vez no pueden
// gastar la misma unidad.
//
// Y cuando no queda nada, se avisa: hasta esta fecha el bot se callaba sin
// que nadie se enterase. Un aviso por mes (capAlertedAt), que lo devuelve
// alertNow para que el llamante mande el correo.
// =============================================================================

export interface ChatbotAllowanceInput {
  clientProductId: string;
  clientId: string;
  tenantId: string | null;
  tier: string | null;
}

export type ChatbotAllowance =
  | { allowed: true; used: number; cap: number; fromPack?: boolean }
  /** alertNow: es la PRIMERA vez este mes que se topa sin saldo, y el
   *  llamante debe avisar al cliente. Las siguientes llegan en false. */
  | { allowed: false; used: number; cap: number; alertNow?: boolean };

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
      select: {
        id: true,
        messagesThisMonth: true,
        usageResetAt: true,
        capOverride: true,
        packMessagesRemaining: true,
        capAlertedAt: true,
      },
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
        data: { messagesThisMonth: 1, usageResetAt: now, capAlertedAt: null },
      });
      return { allowed: true, used: 1, cap };
    }

    if (existing.messagesThisMonth >= cap) {
      // Cupo del mes gastado: tira del pack si queda.
      if ((existing.packMessagesRemaining ?? 0) > 0) {
        const fromPack = await prisma.chatbotUsage.updateMany({
          where: { id: existing.id, packMessagesRemaining: { gt: 0 } },
          data: { packMessagesRemaining: { decrement: 1 }, messagesThisMonth: { increment: 1 } },
        });
        if (fromPack.count > 0) {
          return { allowed: true, used: existing.messagesThisMonth + 1, cap, fromPack: true };
        }
      }
      // Sin saldo. Se marca el aviso solo si nadie lo marcó antes este mes.
      const alert = existing.capAlertedAt
        ? { count: 0 }
        : await prisma.chatbotUsage.updateMany({
            where: { id: existing.id, capAlertedAt: null },
            data: { capAlertedAt: now },
          });
      return { allowed: false, used: existing.messagesThisMonth, cap, alertNow: alert.count > 0 };
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

/** Lo consumido hasta ahora, para enseñarlo. No toca el contador.
 *  packRemaining: mensajes de packs comprados que quedan (no caducan). */
export async function readMessageUsage(
  prisma: PrismaClient,
  clientProductId: string,
  tier: string | null,
  now: Date = new Date(),
): Promise<{ used: number; cap: number; packRemaining: number }> {
  const caps = await getChatbotMessageCaps();
  const row = await prisma.chatbotUsage.findUnique({
    where: { clientProductId },
    select: { messagesThisMonth: true, usageResetAt: true, capOverride: true, packMessagesRemaining: true },
  });
  const cap = row?.capOverride ?? capForTier(tier, caps);
  const packRemaining = row?.packMessagesRemaining ?? 0;
  if (!row || isNewCalendarMonth(row.usageResetAt, now)) return { used: 0, cap, packRemaining };
  // Lo que pasó del cupo se pagó con pack: el mes enseña el cupo, no más.
  return { used: Math.min(row.messagesThisMonth, cap), cap, packRemaining };
}
