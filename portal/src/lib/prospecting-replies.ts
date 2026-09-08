import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from './observability';

// =============================================================================
// Fase 3.3 — el corte de la secuencia de seguimiento.
//
// Una secuencia de mensajes en frío que sigue disparando después de que el
// prospecto haya contestado no es "insistencia": es el patrón exacto que
// hace que reporten el número del cliente. Por eso la parada al responder
// no es un extra de la secuencia, es su requisito.
//
// Cómo se entera el portal de que el prospecto ha respondido: el mensaje
// entrante llega por las rutas internas de WhatsApp (.../reply y
// .../message con role 'user'), que solo conocen el teléfono del remitente.
// Aquí se traduce ese teléfono al Lead outbound al que corresponde.
//
// Se engancha SOLO en WhatsApp porque es el único canal por el que este
// producto contacta (prospecting-contact.ts). Si algún día contacta por
// otro, hay que engancharlo también ahí: nada en este módulo lo detecta
// solo.
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** Un prospecto que escribe tres meses después del último toque no está
 *  respondiendo a la secuencia: la secuencia ya se agotó hace mucho. El
 *  corte existe para acotar el conjunto que hay que revisar en cada
 *  mensaje entrante, que si no crecería para siempre. */
export const REPLY_ATTRIBUTION_MAX_AGE_DAYS = 90;

/** Por debajo de esto no se compara: dos números de 6 dígitos coincidiendo
 *  no dice nada, y una falsa coincidencia aquí significa dar por respondido
 *  a un prospecto que no ha dicho nada (se le deja de escribir sin motivo). */
export const MIN_PHONE_MATCH_DIGITS = 9;

/** Solo los dígitos. Google Places devuelve `internationalPhoneNumber`
 *  ("+34 928 12 34 56") y Meta manda el `wa_id` en crudo ("34928123456"):
 *  literalmente nunca coinciden como cadenas. */
export function phoneDigits(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

/**
 * Compara por sufijo, no por igualdad. Places suele dar el número con
 * prefijo de país y Meta siempre lo da con él, pero un número guardado a
 * mano puede venir en formato nacional ("928123456"), y esos dos son el
 * mismo teléfono. Se compara la cola común de ambos, exigiendo que tenga
 * al menos MIN_PHONE_MATCH_DIGITS.
 */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = phoneDigits(a);
  const right = phoneDigits(b);
  const common = Math.min(left.length, right.length);
  if (common < MIN_PHONE_MATCH_DIGITS) return false;
  return left.slice(-common) === right.slice(-common);
}

export interface MarkProspectRepliedResult {
  matched: number;
}

/**
 * Estampa `repliedAt` en los leads outbound de este cliente cuyo teléfono
 * coincide con el del mensaje entrante.
 *
 * **Nunca lanza.** Se llama desde la ruta que responde a un mensaje
 * entrante, y ahí lo que importa es contestarle al prospecto: que la
 * atribución falle no puede tumbar la conversación. Devuelve `{matched: 0}`
 * y lo deja registrado.
 *
 * El estado del lead NO cambia. Responder no es comprar; marcarlo
 * 'convertido' sería decidir por el comercial del cliente. Lo único que
 * cambia es que deja de recibir toques.
 *
 * Puede marcar más de un lead: dos locales del mismo negocio comparten
 * teléfono con frecuencia, y a ninguno de los dos hay que seguir
 * escribiéndole.
 */
export async function markProspectReplied(
  prisma: PrismaClient,
  input: { clientId: string; phone: string; now?: Date },
): Promise<MarkProspectRepliedResult> {
  const now = input.now ?? new Date();

  try {
    if (phoneDigits(input.phone).length < MIN_PHONE_MATCH_DIGITS) {
      return { matched: 0 };
    }

    const candidates = await prisma.lead.findMany({
      where: {
        clientId: input.clientId,
        source: 'outbound',
        repliedAt: null,
        contactPhone: { not: null },
        contactedAt: { gte: new Date(now.getTime() - REPLY_ATTRIBUTION_MAX_AGE_DAYS * DAY_MS) },
      },
      select: { id: true, tenantId: true, contactPhone: true, status: true },
    });

    const matches = candidates.filter((lead) => phonesMatch(lead.contactPhone, input.phone));
    if (matches.length === 0) {
      return { matched: 0 };
    }

    for (const lead of matches) {
      await prisma.$transaction(async (tx) => {
        await tx.lead.update({ where: { id: lead.id }, data: { repliedAt: now } });
        await tx.leadAudit.create({
          data: {
            leadId: lead.id,
            clientId: input.clientId,
            tenantId: lead.tenantId,
            action: 'replied',
            statusBefore: lead.status,
            statusAfter: lead.status,
            actorId: 'system:prospecting',
          },
        });
      });
    }

    return { matched: matches.length };
  } catch (err) {
    logError('prospecting_replies.mark_failed', err, { clientId: input.clientId }, 'warn');
    return { matched: 0 };
  }
}
