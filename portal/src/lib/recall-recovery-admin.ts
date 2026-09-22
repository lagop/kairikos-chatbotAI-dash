import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// Recuperación dentro de `recall` — lo que comparten las rutas de operador.
//
// Dos reglas que, repetidas en cada ruta, acabarían divergiendo:
//
//   1. EL CLIENTE SALE DE LA SUSCRIPCIÓN, no del cuerpo. Las rutas reciben
//      el id de la suscripción en la URL y de ahí se leen clientId y
//      tenantId en la base. Un clientId en el cuerpo permitiría importar
//      contactos o crear campañas en la cuenta de otro negocio.
//
//   2. HAY ACCIONES QUE TIENEN QUE QUEDAR ATRIBUIDAS A UNA PERSONA.
//      APROBAR una campaña —la decisión de escribir a clientes reales— y
//      CONFIRMAR una importación con su declaración de origen dejan un
//      registro cuyo único valor es decir quién fue, así que el operador
//      se lee de la base antes de actuar: una sesión cuyo Operator ya no
//      existe se niega en vez de firmar a nombre de nadie.
//
// Es la misma idea con la que se diseñó RecoveryCampaign: la aprobación
// humana no es un paso del flujo, es la garantía, y una garantía sin
// nadie detrás no garantiza nada.
//
// Hasta el 22/09/2026 había además un motivo 'not_attributable' para la
// clave compartida KAIA_OPERATOR_API_KEY (operatorId 'legacy'); esa
// clave se retiró y authenticateAdminRequest solo devuelve operadores
// reales.
// =============================================================================

export interface RecallSubscriptionRef {
  id: string;
  clientId: string;
  tenantId: string | null;
}

export async function loadRecallSubscription(
  prisma: PrismaClient,
  subscriptionId: string,
): Promise<RecallSubscriptionRef | null> {
  // Un id que no es un uuid haría fallar a Postgres con un error de tipo en
  // vez de devolver "no existe". Se descarta antes.
  if (!/^[0-9a-f-]{36}$/i.test(subscriptionId)) return null;
  return prisma.recallSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, clientId: true, tenantId: true },
  });
}

export type AttributableOperator =
  | { ok: true; operatorId: string; email: string }
  | { ok: false; reason: 'operator_not_found' };

/** Resuelve el operador de verdad detrás de la sesión, o se niega. */
export async function resolveAttributableOperator(
  prisma: PrismaClient,
  operatorId: string,
): Promise<AttributableOperator> {
  const operator = await prisma.operator.findUnique({
    where: { id: operatorId },
    select: { id: true, email: true },
  });
  if (!operator) return { ok: false, reason: 'operator_not_found' };
  return { ok: true, operatorId: operator.id, email: operator.email };
}

/** Tope del CSV que se acepta por petición. Un export de facturación de un
 *  profesional con años de histórico ronda el megabyte; cinco dejan margen
 *  sin dejar la puerta abierta a subir cualquier cosa. */
export const MAX_CSV_CHARS = 5_000_000;
