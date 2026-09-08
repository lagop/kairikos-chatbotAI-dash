import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { CHATBOT_PRODUCT_CODE, WIZARD_STEP_CATALOG } from './wizard-catalog';
import { jsonToObject } from './wizard-tier-prisma';
import { logError } from './observability';

// =============================================================================
// Fase 4 — encadenar productos: lo que el cliente ya nos contó una vez no
// se le vuelve a preguntar.
//
// **Por qué esto y no CROSS_PRODUCT_FIELD_MAP.** Aquel mecanismo
// (cross-product-seed.ts) empareja campos entre PASOS DE WIZARD de dos
// productos, y su comentario dice que está vacío porque solo 'chatbot'
// tiene catálogo de wizard. Eso sigue siendo verdad, y además ya no va a
// cambiar: la cualificación de leads y el perfil de SEO se construyeron
// como tarjetas propias con tabla propia —LeadQualificationProfile,
// SeoProfile—, no como pasos de wizard, y esa decisión se tomó a
// conciencia (el motor del wizard carga con aprobación por operador,
// visibilidad por tarifa y versionado que esos productos no necesitan).
//
// Así que la correspondencia real no es paso→paso, es TABLA→TABLA, y
// forzarla dentro de un mapa claveado por stepKey exigiría inventarse
// stepKeys que no existen. Aquel mecanismo se queda donde está, sirviendo
// para wizard→wizard el día que haya un segundo wizard; esto cubre lo que
// hay hoy.
//
// Se conserva la propiedad que hacía bueno al original: **es de solo
// lectura**. Nunca escribe una fila. Devuelve sugerencias que la pantalla
// enseña como valor inicial, y en cuanto el cliente guarda lo suyo, lo
// suyo manda. No hay bandera que limpiar ni copia que sincronizar.
// =============================================================================

export interface PrefillSuggestion {
  /** Campo del formulario destino. */
  field: string;
  value: string;
  /** De dónde salió, para poder decírselo: «lo cogimos de tu chatbot». */
  sourceLabel: string;
}

const CHATBOT_LABEL = 'lo que nos contaste al configurar tu chatbot';

/** El stepKey se saca del catálogo y no se escribe a mano: hoy son '1'..'12'
 *  y no los nombres de los pasos, que es justo el error que se comete al
 *  suponerlo. Si el catálogo cambia de claves, esto lo sigue. */
const PERFIL_STEP = WIZARD_STEP_CATALOG[1].key;
const CAPTACION_STEP = WIZARD_STEP_CATALOG[6].key;

/** Lee el payload aprobado de un paso del wizard de chatbot. Solo
 *  `activeForBot`: sugerir a partir de un borrador que ningún operador ha
 *  revisado propagaría a otro producto algo que ni el bot está usando. */
async function activeStepPayload(
  prisma: PrismaClient,
  clientId: string,
  stepKey: string,
): Promise<Record<string, unknown> | null> {
  const row = await prisma.chatbotConfigStep.findFirst({
    where: { clientId, productCode: CHATBOT_PRODUCT_CODE, stepKey, activeForBot: true },
    select: { payload: true },
  });
  return row ? jsonToObject(row.payload) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Qué se le puede precargar al perfil de SEO.
 *
 * Solo se sugiere lo que está VACÍO en el destino: pisar lo que el cliente
 * ya escribió con lo que dijo en otro sitio es peor que no sugerir nada,
 * porque le cambia una respuesta suya sin avisar.
 *
 * **Nunca lanza.** Es un adorno de una pantalla que tiene que abrir igual:
 * un fallo aquí devuelve cero sugerencias, no un error.
 */
export async function suggestSeoProfileFields(
  prisma: PrismaClient,
  clientId: string,
  current: { businessDescription: string | null; siteUrl: string | null } | null,
): Promise<PrefillSuggestion[]> {
  try {
    const suggestions: PrefillSuggestion[] = [];
    const perfil = await activeStepPayload(prisma, clientId, PERFIL_STEP);
    if (!perfil) return [];

    // La web del negocio: el paso 1 del wizard ya la pide, y el perfil de
    // SEO la vuelve a pedir palabra por palabra.
    const web = nonEmptyString(perfil.web);
    if (web && !nonEmptyString(current?.siteUrl ?? null)) {
      suggestions.push({ field: 'siteUrl', value: web, sourceLabel: CHATBOT_LABEL });
    }

    // A qué se dedica: el nombre comercial y el sector no son la
    // descripción, pero juntos son un primer borrador mucho mejor que un
    // campo en blanco.
    const nombre = nonEmptyString(perfil.nombre_comercial);
    const vertical = nonEmptyString(perfil.vertical);
    if (nombre && !nonEmptyString(current?.businessDescription ?? null)) {
      suggestions.push({
        field: 'businessDescription',
        value: vertical && vertical !== 'otro' ? `${nombre}, ${vertical}.` : `${nombre}.`,
        sourceLabel: CHATBOT_LABEL,
      });
    }

    return suggestions;
  } catch (err) {
    logError('cross_product_prefill.seo_failed', err, { clientId }, 'warn');
    return [];
  }
}

/**
 * Qué se le puede precargar a la cualificación de leads.
 *
 * El paso 6 del chatbot («Captación de leads») ya pregunta a dónde avisar
 * de un contacto nuevo. Es literalmente el mismo dato que `emailAviso`, y
 * es la correspondencia concreta que el plan de WP-29 documentaba y no se
 * pudo codificar entonces.
 */
export async function suggestLeadQualificationFields(
  prisma: PrismaClient,
  clientId: string,
  current: { emailAviso: string | null } | null,
): Promise<PrefillSuggestion[]> {
  try {
    const captacion = await activeStepPayload(prisma, clientId, CAPTACION_STEP);
    if (!captacion) return [];

    const email = nonEmptyString(captacion.email_notificacion);
    if (!email || nonEmptyString(current?.emailAviso ?? null)) return [];

    // El paso 6 admite varios separados por comas; aquí solo cabe uno, así
    // que se sugiere el primero en vez de pegar la lista entera en un
    // campo que la rechazaría.
    const first = email.split(',')[0]?.trim();
    if (!first) return [];

    return [{ field: 'emailAviso', value: first, sourceLabel: CHATBOT_LABEL }];
  } catch (err) {
    logError('cross_product_prefill.leads_failed', err, { clientId }, 'warn');
    return [];
  }
}

/** Las sugerencias como objeto, listo para mezclar con el valor actual de
 *  un formulario. Puro: la pantalla decide qué hacer con ellas. */
export function suggestionsToValues(suggestions: readonly PrefillSuggestion[]): Record<string, string> {
  return Object.fromEntries(suggestions.map((s) => [s.field, s.value]));
}
