import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { normaliseE164 } from './recall-blocklist';

// =============================================================================
// Fase 0 — el aviso de oposición y la baja de quien llamó.
//
// POR QUÉ ESTO EXISTE, Y POR QUÉ NO PODÍA ESPERAR
//
// Hasta ahora el primer mensaje al llamante no ofrecía ninguna forma de
// oponerse. Eso no rompía nada hoy —son mensajes de utilidad, contestando
// a una llamada que la persona acaba de hacer— pero SÍ hipoteca mañana:
// para poder usar después esos números en campañas de recuperación
// (LSSI art. 21.2 en España, PECR reg. 22(3) en Reino Unido) hace falta,
// entre otras condiciones, haber dado la opción de oponerse EN EL MOMENTO
// DE RECOGER EL DATO. Y eso no tiene arreglo retroactivo: los contactos
// acumulados sin ese aviso no se vuelven utilizables por añadirlo luego.
//
// DOS REGLAS QUE NO SON ADORNO
//
//   1. El aviso va VERSIONADO. `LEGAL_NOTICE_VERSION` se sella en el
//      CallEvent junto al envío, y el texto exacto de cada versión se
//      queda aquí escrito para siempre. Si dentro de un año alguien
//      reclama, la pregunta no será "qué dice hoy la plantilla" sino
//      "qué leyó ESTA persona en marzo" — y sin el número de versión esa
//      pregunta no tiene respuesta.
//
//   2. La baja se atiende por CUALQUIER PALABRA RAZONABLE, no solo por
//      una mágica. Es requisito explícito en EE. UU. (la FCC obliga a
//      atender la revocación por cualquier medio razonable) y es sentido
//      común en todas partes: quien escribe "no me escribáis más" se ha
//      dado de baja, aunque la plantilla dijera "responde BAJA".
//
// LO QUE ESTE MÓDULO NO CUBRE, Y SE SABE
//
// La baja solo se detecta por WhatsApp, que es por donde entra la
// respuesta (ver /api/internal/recall/whatsapp-reply). Un SMS de vuelta
// NO se procesa hoy: no existe ninguna ruta de SMS entrante en el repo.
// El aviso sí viaja en el SMS de respaldo, así que a quien no tiene
// WhatsApp se le está ofreciendo una salida que no se le atiende sola.
// Es una limitación aceptada, no un descuido: el respaldo por SMS es
// ~1 de cada 7 llamantes y la salida manual existe (el dueño bloquea el
// número desde /portal/llamadas). Cuando haya ruta de SMS entrante,
// `isOptOutRequest` ya sirve tal cual.
// =============================================================================

/**
 * La versión del aviso que se está enviando AHORA MISMO.
 *
 * Al cambiar el texto se sube la versión, y el texto viejo se queda en
 * PREVIOUS_NOTICES. Nunca se edita una entrada publicada.
 */
export const LEGAL_NOTICE_VERSION = '2026-09-v1';

/**
 * El aviso, tal y como va pegado al final de cada mensaje de primer
 * contacto — plantillas de WhatsApp y SMS de respaldo por igual.
 *
 * Se declara aquí y lo importa recall-templates.ts en vez de escribirlo
 * a mano en cada plantilla, por el mismo motivo que RECALL_TEMPLATES no
 * redefine los nombres: tres copias del mismo texto legal divergen, y la
 * que divergiría es justo la que nadie vuelve a leer.
 *
 * REDACCIÓN PENDIENTE DE REVISIÓN JURÍDICA. Cumple lo que pide el marco
 * (identifica al remitente vía el nombre del negocio que ya lleva el
 * mensaje, y ofrece una salida clara y gratuita), pero quien responde
 * ante la AEPD es el cliente: que lo lea un abogado antes del primer
 * envío a un número real.
 */
export const LEGAL_NOTICE_TEXT = 'Si no quieres recibir más mensajes nuestros, responde BAJA.';

/** Histórico. Append-only: una versión publicada no se edita ni se borra. */
export const PREVIOUS_NOTICES: Readonly<Record<string, string>> = {};

/**
 * Lo que se le contesta a quien se da de baja.
 *
 * Una sola confirmación y sin una palabra comercial: el mensaje de
 * despedida no es el sitio para intentar retenerle, y en varios marcos
 * un "¿seguro? mira todo lo que te pierdes" convierte la confirmación en
 * otra comunicación comercial no consentida.
 */
export const OPT_OUT_CONFIRMATION = 'Hecho, no volverás a recibir mensajes nuestros.';

/** Motivo con el que se marca el bloqueo, para distinguirlo del que pone
 *  el dueño a mano contra un comercial pesado. */
export const OPT_OUT_REASON = 'opt_out';

// ---------------------------------------------------------------------------
// Detección
// ---------------------------------------------------------------------------

/** Quita acentos, signos y dobles espacios: "¡BAJA!" y "baja" son lo mismo. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Mensajes que SON exactamente una baja. Se comparan enteros.
 *
 * Incluye inglés porque un turista que llama a un taller en Málaga
 * escribe "stop", no "baja".
 */
const EXACT_OPT_OUTS = new Set([
  'baja',
  'darme de baja',
  'date de baja',
  'me doy de baja',
  'quiero darme de baja',
  'stop',
  'unsubscribe',
  'parar',
  'para',
  'basta',
  'cancelar',
  // 'no' A SECAS NO ESTÁ AQUÍ, Y ES DELIBERADO. Es la única respuesta
  // ambigua que de verdad va a ocurrir: a una oferta de huecos, «no»
  // significa casi siempre «ninguno me viene bien», no «no me escribáis
  // más». Como la baja es irreversible (ver optOutAt), el coste de
  // acertar por exceso aquí no es un mensaje de menos — es suprimir para
  // siempre a alguien que estaba pidiendo que le llamaran.
  'no gracias',
  'no me interesa',
  'dejadme en paz',
  'dejame en paz',
  'no escribas',
  'no escribais',
  'no me escribas',
  'no me escribais',
  'no me escribas mas',
  'no me escribais mas',
  'no quiero mas mensajes',
  'no quiero recibir mas mensajes',
  'borradme',
  'borrame',
  'eliminadme',
]);

/**
 * Tokens que delatan una baja aunque la frase no esté en la lista de
 * arriba, siempre que el mensaje sea CORTO.
 *
 * Lo de "corto" es la parte importante y es deliberada: sin ese límite,
 * "no puedo el martes, mejor llamadme el miércoles" contiene "no" y se
 * leería como una baja. Suprimiríamos a alguien que estaba pidiendo
 * justo lo contrario, y en silencio.
 */
const OPT_OUT_TOKENS = ['baja', 'stop', 'unsubscribe', 'basta', 'borrame', 'borradme'];
const SHORT_MESSAGE_WORDS = 4;

/**
 * ¿Esta respuesta es una petición de baja?
 *
 * Generosa a propósito, y asimétrica a propósito. Equivocarse por exceso
 * cuesta un mensaje que no se manda; equivocarse por defecto cuesta
 * seguir escribiendo a quien pidió que parásemos, que es exactamente la
 * reclamación que este módulo existe para evitar.
 */
export function isOptOutRequest(text: string): boolean {
  const clean = normalise(text);
  if (!clean) return false;
  if (EXACT_OPT_OUTS.has(clean)) return true;

  const words = clean.split(' ');
  if (words.length > SHORT_MESSAGE_WORDS) return false;
  return OPT_OUT_TOKENS.some((token) => words.includes(token));
}

// ---------------------------------------------------------------------------
// Aplicación
// ---------------------------------------------------------------------------

export type OptOutResult =
  | { status: 'suppressed'; e164: string; alreadySuppressed: boolean }
  | { status: 'ignored'; reason: 'not_an_opt_out' | 'invalid_number' };

/**
 * Da de baja a un número dentro de una suscripción.
 *
 * Escribe en RecallBlockedNumber en vez de crear una tabla propia: el
 * efecto es idéntico —no se le vuelve a escribir— y la lista ya se
 * comprueba en los dos sitios que importan (el webhook de voz y el envío,
 * ver la cabecera de recall-blocklist.ts). Una segunda lista sería una
 * segunda cosa que olvidar consultar.
 *
 * Lo que SÍ la distingue es `optOutAt`: un bloqueo que puso el dueño lo
 * puede quitar el dueño, y una baja que pidió el llamante NO. Por eso es
 * una columna y no el texto libre de `reason` — un guardia que depende de
 * que nadie reescriba una cadena no es un guardia.
 */
export async function applyOptOut(
  prisma: PrismaClient,
  input: { subscriptionId: string; clientId: string; from: string; text: string; now?: Date },
): Promise<OptOutResult> {
  if (!isOptOutRequest(input.text)) return { status: 'ignored', reason: 'not_an_opt_out' };

  const e164 = normaliseE164(input.from);
  if (!e164) return { status: 'ignored', reason: 'invalid_number' };

  const now = input.now ?? new Date();
  const existing = await prisma.recallBlockedNumber.findUnique({
    where: { subscriptionId_e164: { subscriptionId: input.subscriptionId, e164 } },
    select: { optOutAt: true },
  });

  await prisma.recallBlockedNumber.upsert({
    where: { subscriptionId_e164: { subscriptionId: input.subscriptionId, e164 } },
    create: {
      subscriptionId: input.subscriptionId,
      clientId: input.clientId,
      e164,
      reason: OPT_OUT_REASON,
      createdBy: `caller:${e164}`,
      optOutAt: now,
    },
    // Un número que el dueño ya había bloqueado y que ADEMÁS pide la baja
    // pasa a ser irreversible: se sella optOutAt sin tocar quién lo puso.
    // Nunca se limpia una fecha de baja ya sellada.
    update: { optOutAt: existing?.optOutAt ?? now },
    select: { id: true },
  });

  return { status: 'suppressed', e164, alreadySuppressed: existing?.optOutAt != null };
}
