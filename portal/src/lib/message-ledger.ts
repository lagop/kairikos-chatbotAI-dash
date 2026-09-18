import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from './observability';

// =============================================================================
// Fase 0 — el libro mayor de mensajes salientes.
//
// QUÉ PROBLEMA RESUELVE
//
// Hoy el portal sabe CUÁNTOS mensajes mandó (RecallUsageMonth) y no sabe
// DE QUÉ TIPO era ninguno. Mientras todas las categorías de WhatsApp
// costaron lo mismo, la diferencia era teórica. En cuanto dejen de costar
// lo mismo, un contador agregado no se puede desagregar hacia atrás —
// el dato no está aquí, y en el proveedor deja de estar pasados sus
// propios plazos de retención.
//
// Por eso esto se construye ANTES que cualquier informe que lo explote.
// Los informes se pueden escribir en cualquier momento; las filas, no.
//
// NUNCA LANZA, Y ESO ES LA DECISIÓN IMPORTANTE
//
// Registrar es contabilidad, enviar es el producto. Si la escritura del
// libro mayor falla, el mensaje YA SALIÓ: propagar ese error haría que el
// llamante se quedara sin respuesta por un fallo de nuestra contabilidad,
// e —igual de malo— haría que el barrido reintentara un envío que ya se
// hizo. Así que se registra el fallo y se sigue, como hace
// sendCallbackReply con su acuse.
//
// El precio que se paga por esa decisión es que el libro mayor puede
// tener agujeros si Postgres se cae. Es el lado correcto del trato: un
// agujero conocido en la contabilidad es recuperable contra la factura
// del proveedor; un mensaje duplicado a un cliente final, no.
//
// EL COSTE NO SE ESCRIBE AQUÍ
//
// Ni Meta ni Twilio devuelven el precio en la respuesta del envío. La
// fila nace con `costAmount` a NULL y la completa después una
// conciliación contra el proveedor, casando por `providerMessageId`.
// Meter aquí una tarifa de una tabla fija sería peor que el NULL:
// parecería un dato del proveedor y sería una estimación nuestra.
// =============================================================================

/** Los valores que admite `category`, que es la columna que decide el precio. */
export type MessageCategory = 'UTILITY' | 'MARKETING' | 'SERVICE' | 'AUTHENTICATION';

export interface RecordSendInput {
  clientId: string;
  tenantId?: string | null;
  /** 'recall' | 'prospecting' | 'reviews' | 'chatbot' */
  productCode: string;
  /** Fase 3 multi-instancia — de qué línea de recall salió, para poder
   *  repartir el coste cuando un cliente tiene varias. Solo lo llevan las
   *  filas de 'recall': un envío de prospección o de reseñas no tiene línea.
   *
   *  No basta con callEventId: ése solo existe en los envíos que nacen de una
   *  llamada, no en los códigos de desvío ni en las campañas de recuperación. */
  subscriptionId?: string | null;
  channel: 'whatsapp' | 'sms';
  kind: 'template' | 'free_form';
  /** Nula en SMS y en mensaje libre: allí el concepto no existe. */
  category?: MessageCategory | null;
  templateName?: string | null;
  toE164: string;
  providerMessageId?: string | null;
  ok: boolean;
  error?: string | null;
  callEventId?: string | null;
  sentAt?: Date;
}

/**
 * Apunta un envío en el libro mayor.
 *
 * Se llama DESPUÉS del envío y con su desenlace, no antes: lo que
 * interesa registrar es lo que pasó de verdad, no lo que se intentó.
 *
 * Los fallos se apuntan igual que los aciertos. Un envío rechazado no
 * cuesta dinero, pero sin su fila la pregunta "¿por qué en marzo hay
 * cuarenta mensajes menos que en febrero?" no tiene respuesta, y esa
 * pregunta es la mitad de para qué sirve un libro mayor.
 */
export async function recordSend(prisma: PrismaClient, input: RecordSendInput): Promise<void> {
  try {
    await prisma.outboundMessage.create({
      data: {
        clientId: input.clientId,
        subscriptionId: input.subscriptionId ?? null,
        tenantId: input.tenantId ?? null,
        productCode: input.productCode,
        channel: input.channel,
        kind: input.kind,
        category: input.category ?? null,
        templateName: input.templateName ?? null,
        toE164: input.toE164,
        providerMessageId: input.providerMessageId ?? null,
        ok: input.ok,
        // Acotado como callerNotifyError: un error de proveedor puede
        // traer un cuerpo entero y esta columna no es un log.
        error: input.error ? input.error.slice(0, 500) : null,
        callEventId: input.callEventId ?? null,
        sentAt: input.sentAt ?? new Date(),
      },
    });
  } catch (err) {
    // Ver la cabecera: esto no puede tumbar un envío que ya salió.
    logError(
      'message_ledger.record_failed',
      err,
      { clientId: input.clientId, productCode: input.productCode, channel: input.channel },
      'warn',
    );
  }
}

/**
 * Saca el id de mensaje de una respuesta de la Graph API de Meta.
 *
 * Meta lo devuelve en `messages[0].id` y es la única clave por la que se
 * puede casar esta fila con su línea en la factura. Se aísla en una
 * función porque la forma de la respuesta es de Meta, no nuestra, y
 * cuando cambie habrá un solo sitio que tocar.
 */
export function metaMessageId(data: { messages?: Array<{ id: string }> } | undefined): string | null {
  return data?.messages?.[0]?.id ?? null;
}
