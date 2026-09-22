import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { canSignContract } from './recall';

// =============================================================================
// Fase 6 — los dos huecos de "Cadena de entrega por producto" para
// 'recall': ni una sola RecallSubscription se creaba en todo el
// repositorio, y `contract_signed` no tenía quien lo escribiera.
//
// Los dos viven en el mismo archivo porque los dos son "arrancar el
// producto", no "operarlo" — a diferencia de recall-numbers.ts/
// recall-calls.ts/recall-templates.ts/recall-meta.ts, que son cada uno
// sobre un RECURSO (número, llamada, plantilla, conexión), esto es sobre
// el ARRANQUE: la fila que hace falta para que exista algo que operar, y
// el único paso manual de la secuencia feliz que no es la unión de un
// recurso.
// =============================================================================

export type EnsureRecallSubscriptionActor =
  | { type: 'system'; source: string }
  | { type: 'operator'; operatorId: string };

export interface EnsureRecallSubscriptionParams {
  clientId: string;
  clientProductId: string;
  tenantId: string | null;
}

export interface EnsureRecallSubscriptionResult {
  /** false cuando ya existía — el llamante no necesita distinguir "la
   *  acabo de crear" de "ya estaba", solo saber que hay una fila. */
  created: boolean;
  subscriptionId: string;
}

/**
 * Crea la RecallSubscription de un ClientProduct de 'recall' si todavía
 * no tiene una. Nunca la resucita ni le toca el estado si ya existe —
 * una RecallSubscription cancelada que se reactiva es una pregunta
 * distinta (¿vuelve a 'paid'? ¿al estado en que se quedó?) que este
 * hueco concreto no responde; se deja anotado, no resuelto en silencio.
 *
 * Compare-and-swap contra la unicidad de `clientProductId`: si dos
 * llamadas llegan a la vez (un reintento del webhook de Stripe y un
 * reintento manual del operador, por ejemplo), la segunda `create`
 * choca contra esa unicidad en vez de duplicar la fila — se trata como
 * éxito, no como fallo.
 *
 * Corre FUERA de la transacción que activa el ClientProduct (igual que
 * el aviso de config_complete en wizard-review.ts): esto no es parte de
 * "cobrar", es un efecto posterior, y anidar una transacción dentro de
 * otra no es lo que necesita esta función.
 */
export async function ensureRecallSubscription(
  prisma: PrismaClient,
  params: EnsureRecallSubscriptionParams,
  actor: EnsureRecallSubscriptionActor,
): Promise<EnsureRecallSubscriptionResult> {
  const existing = await prisma.recallSubscription.findUnique({
    where: { clientProductId: params.clientProductId },
    select: { id: true },
  });
  if (existing) return { created: false, subscriptionId: existing.id };

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.recallSubscription.create({
        data: {
          clientId: params.clientId,
          clientProductId: params.clientProductId,
          tenantId: params.tenantId,
          // status: 'paid' es el default del esquema — el primer paso
          // de la secuencia feliz, exactamente lo que "recién pagado,
          // sin contrato todavía" significa.
        },
      });
      await tx.recallSubscriptionAudit.create({
        data: {
          subscriptionId: row.id,
          clientId: params.clientId,
          action: 'created',
          after: { status: 'paid' },
          actorType: actor.type,
          actorOperatorId: actor.type === 'operator' ? actor.operatorId : null,
          actorEmail: actor.type === 'system' ? `system:${actor.source}` : null,
        },
      });
      return row;
    });
    return { created: true, subscriptionId: created.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Perdió la carrera: otra llamada la creó entre el findUnique de
      // arriba y este create. No es un fallo, es justo lo que el
      // compare-and-swap existe para manejar.
      const winner = await prisma.recallSubscription.findUniqueOrThrow({
        where: { clientProductId: params.clientProductId },
        select: { id: true },
      });
      return { created: false, subscriptionId: winner.id };
    }
    throw err;
  }
}

export type MarkContractSignedResult =
  | { ok: true }
  | { ok: false; error: 'subscription_not_found' | 'invalid_status' };

/**
 * El operador confirma que el contrato está firmado — un hecho ocurrido
 * fuera del portal (una llamada, un correo, ver recall.ts's canSignContract
 * y la copia del cliente en /portal/llamadas), no algo que el sistema
 * pueda verificar solo. Legal únicamente desde 'paid'.
 */
export async function markContractSigned(
  prisma: PrismaClient,
  subscriptionId: string,
  actor: { operatorId: string },
): Promise<MarkContractSignedResult> {
  const subscription = await prisma.recallSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, clientId: true, status: true },
  });
  if (!subscription) return { ok: false, error: 'subscription_not_found' };
  if (!canSignContract(subscription.status)) return { ok: false, error: 'invalid_status' };

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.recallSubscription.update({
      where: { id: subscriptionId },
      data: { status: 'contract_signed', contractSignedAt: now },
    });
    await tx.recallSubscriptionAudit.create({
      data: {
        subscriptionId,
        clientId: subscription.clientId,
        action: 'contract_signed',
        before: { status: subscription.status },
        after: { status: 'contract_signed' },
        actorType: 'operator',
        actorOperatorId: actor.operatorId,
      },
    });
  });

  return { ok: true };
}
