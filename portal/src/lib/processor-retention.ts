import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';

// =============================================================================
// Plazos de conservación de datos que el portal trata POR CUENTA de sus
// clientes y que no tenían ninguno (26/11/2026, «Fuera de estos PR» del plan
// del encargo del tratamiento). Lo llama el cron retention-purge, después de
// retention-purge.ts (lo de Kairikos como responsable) y del chat.
//
//  - ChannelWebhookDelivery.payload — lo que se manda al CRM del cliente o a
//    n8n: nombre, teléfono, mensaje de la solicitud. Solo sirve para entregar
//    y reintentar, y el último reintento automático llega a las ~6 h
//    (channel-webhook.ts, BACKOFF_MINUTES). A los 30 días se vacía. La fila se
//    queda, sin datos personales, como rastro del envío. Si a esa edad seguía
//    sin entregarse (pending o failed), pasa a 'expired' y ya no se puede
//    reintentar: no queda nada que mandar.
//
//  - OutboundMessage.toE164 — el número al que se mandó cada WhatsApp o SMS.
//    A los 12 meses del envío se pone a NULL. Se quedan el coste, el canal,
//    la plantilla y la fecha, que son lo que necesita el informe de margen.
//    Efecto aceptado: pasado un año, una campaña de recuperación ya no sabe
//    que a ese número se le escribió (recovery-campaigns.ts) y puede volver
//    a hacerlo. Los 12 meses son los mismos que los del chat.
//
// Contact (la agenda) no tiene plazo propio a propósito: mucha la importa el
// propio cliente, y es suya mientras tenga el servicio contratado; se borra
// en la baja (client-data-exit.ts) o cuando la pide (supresión por operador).
// Ver docs/datos-de-clientes-rgpd.md.
//
// Idempotente y barato en cada pasada del cron: cada UPDATE solo toca lo que
// todavía tiene datos (payload no vacío, número no nulo).
// =============================================================================

const DAY_MS = 86_400_000;
export const WEBHOOK_PAYLOAD_RETENTION_DAYS = 30;
export const OUTBOUND_NUMBER_RETENTION_DAYS = 365;

export interface ProcessorRetentionResult {
  /** Envíos al CRM entregados (o sin puente) a los que se les vació el payload. */
  webhookPayloadsCleared: number;
  /** Envíos que seguían sin entregarse: payload vacío y estado 'expired'. */
  webhookDeliveriesExpired: number;
  /** Mensajes enviados a los que se les borró el número. */
  outboundNumbersCleared: number;
}

const EMPTY = {} as Prisma.InputJsonValue;
const NOT_EMPTY: Prisma.ChannelWebhookDeliveryWhereInput = { NOT: { payload: { equals: EMPTY } } };

export async function runProcessorDataRetention(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<ProcessorRetentionResult> {
  const webhookCutoff = new Date(now.getTime() - WEBHOOK_PAYLOAD_RETENTION_DAYS * DAY_MS);
  const outboundCutoff = new Date(now.getTime() - OUTBOUND_NUMBER_RETENTION_DAYS * DAY_MS);
  const old = { createdAt: { lt: webhookCutoff }, ...NOT_EMPTY };

  // Primero los que no se entregaron, para que el segundo UPDATE no les vacíe
  // el payload dejándolos en 'failed' (un reintento a mano mandaría {}).
  const expired = await db.channelWebhookDelivery.updateMany({
    where: { ...old, status: { in: ['pending', 'failed'] } },
    data: { payload: EMPTY, status: 'expired', lastError: 'payload_expired' },
  });
  const cleared = await db.channelWebhookDelivery.updateMany({
    where: { ...old, status: { notIn: ['pending', 'failed'] } },
    data: { payload: EMPTY },
  });
  const outbound = await db.outboundMessage.updateMany({
    where: { sentAt: { lt: outboundCutoff }, toE164: { not: null } },
    data: { toE164: null },
  });

  return {
    webhookPayloadsCleared: cleared.count,
    webhookDeliveriesExpired: expired.count,
    outboundNumbersCleared: outbound.count,
  };
}
