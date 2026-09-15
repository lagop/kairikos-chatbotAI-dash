import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { normaliseE164 } from './recall-blocklist';
import { logError } from './observability';

// =============================================================================
// Fase 1 — resolver la persona detrás de una interacción.
//
// Este módulo es pequeño a propósito: es el ÚNICO sitio desde el que nace
// un Contact. Si mañana hay dos, la deduplicación deja de existir en
// silencio — que es justo lo que pasaba antes de que este modelo existiera.
//
// POR QUÉ SE NORMALIZA CON normaliseE164 Y NO CON UNA FUNCIÓN PROPIA
//
// Porque la lista de bloqueo ya normaliza así, y las dos tienen que casar
// EXACTAMENTE: un contacto guardado como '+34651234567' y un bloqueo
// guardado como '651234567' son, para la base de datos, dos personas
// distintas, y la baja de una no silenciaría a la otra. Una segunda
// función de normalización es una forma elegante de romper la supresión.
//
// LA BASE LEGAL NO SE PONE AL CREAR EL CONTACTO
//
// Se pone cuando el aviso de oposición SALE, que es un momento distinto y
// posterior (el mensaje al llamante va 90 segundos después de la llamada,
// y puede no llegar a irse nunca si el número está bloqueado o es
// inalcanzable). De ahí que sean dos funciones y no una: crear el
// contacto es registrar que alguien llamó; sellar la base legal es
// registrar que se le dio una salida. Confundirlas produciría contactos
// que parecen utilizables para campañas sin serlo, que es el error caro.
// =============================================================================

export interface ResolveContactInput {
  clientId: string;
  tenantId?: string | null;
  /** Tal y como llega del proveedor; se normaliza aquí. */
  rawNumber: string | null;
  /** Cuándo ocurrió la interacción. */
  at: Date;
  /** 'inbound_call' | 'lead' | 'import' | 'manual' */
  source?: string;
}

/**
 * Devuelve el contacto de esta interacción, creándolo si es la primera vez.
 *
 * Devuelve `null` —y no lanza— cuando no hay número utilizable: número
 * oculto, o algo que no se puede leer como teléfono. Esa llamada existe y
 * se registra, simplemente no pertenece a nadie identificable, y
 * fabricarle un contacto sería inventarse una persona nueva en cada
 * llamada anónima.
 *
 * Nunca lanza por otros motivos tampoco: si esto fallara, tumbaría el
 * webhook de voz de Twilio, que reintentaría la llamada entera. Perder la
 * fila de contacto es recuperable (la siguiente llamada la crea); perder
 * la llamada, no.
 */
export async function resolveContact(
  prisma: PrismaClient,
  input: ResolveContactInput,
): Promise<string | null> {
  if (!input.rawNumber) return null;
  const e164 = normaliseE164(input.rawNumber);
  if (!e164) return null;

  try {
    const contact = await prisma.contact.upsert({
      where: { clientId_e164: { clientId: input.clientId, e164 } },
      create: {
        clientId: input.clientId,
        tenantId: input.tenantId ?? null,
        e164,
        source: input.source ?? 'inbound_call',
        firstSeenAt: input.at,
        lastInteractionAt: input.at,
      },
      // Vacío a propósito: el avance de lastInteractionAt va aparte, más
      // abajo, porque tiene que ser condicional y un upsert no sabe
      // hacer "solo si es más reciente".
      update: {},
      select: { id: true },
    });

    // Twilio entrega sus webhooks al menos una vez, así que una llamada
    // repetida trae una fecha que YA está registrada — y un reintento
    // tardío de una llamada vieja traería una más antigua que la actual.
    // Retrasar lastInteractionAt haría que un cliente al que acabamos de
    // atender apareciera como dormido en los disparadores de la Fase 3.
    await prisma.contact.updateMany({
      where: { id: contact.id, lastInteractionAt: { lt: input.at } },
      data: { lastInteractionAt: input.at },
    });

    return contact.id;
  } catch (err) {
    logError('contacts.resolve_failed', err, { clientId: input.clientId }, 'warn');
    return null;
  }
}

/**
 * Sella en el contacto la base legal que acredita una interacción concreta.
 *
 * LA PRIMERA GANA. La base legal se captura en el momento de recoger el
 * dato, y un aviso enviado seis meses después no mejora al primero: si ya
 * hay una fecha, no se toca. Por eso el WHERE lleva `legalBasis: null` y
 * no es un simple update — así también es idempotente, que hace falta
 * porque el barrido de notificaciones puede pasar por aquí más veces de
 * las necesarias.
 */
export async function recordLegalBasis(
  prisma: PrismaClient,
  input: {
    contactId: string;
    /** El CallEvent que lo acredita: la evidencia es un puntero a un hecho. */
    evidenceCallEventId: string;
    capturedAt: Date;
    basis?: string;
  },
): Promise<void> {
  try {
    await prisma.contact.updateMany({
      where: { id: input.contactId, legalBasis: null },
      data: {
        legalBasis: input.basis ?? 'inbound_contact',
        legalBasisCapturedAt: input.capturedAt,
        legalBasisEvidenceId: input.evidenceCallEventId,
      },
    });
  } catch (err) {
    // Mismo criterio que el libro mayor: el mensaje ya salió, y un fallo
    // registrando la evidencia no puede deshacerlo ni provocar un reenvío.
    logError('contacts.legal_basis_failed', err, { contactId: input.contactId }, 'warn');
  }
}

/**
 * ¿Se puede meter a este contacto en una campaña de recuperación?
 *
 * Una sola regla y expuesta como función, en vez de repetir el `!= null`
 * por ahí: cuando la Fase 3 traiga los disparadores habrá varios sitios
 * preguntando lo mismo, y la respuesta tiene que ser la misma en todos.
 *
 * Ojo con lo que esto NO comprueba: la supresión. Vive en
 * RecallBlockedNumber y se consulta con isNumberBlocked, deliberadamente
 * en un solo sitio (ver la cabecera de Contact en el esquema). Un
 * disparador tiene que preguntar las dos cosas.
 */
export function hasCampaignableLegalBasis(contact: { legalBasis: string | null }): boolean {
  return contact.legalBasis !== null;
}
