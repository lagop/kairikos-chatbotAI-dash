import 'server-only';
import type { RecoveryTrigger } from './recovery-triggers';
import { LEGAL_NOTICE_TEXT } from './recall-optout';

// =============================================================================
// Fase 3 — las plantillas de las campañas de recuperación.
//
// LA CATEGORÍA NO ES COSMÉTICA: DECIDE EL PRECIO Y LA APROBACIÓN.
//
// Meta separa UTILITY (informa sobre una transacción o relación que ya
// existe) de MARKETING (todo lo demás). Las dos primeras plantillas de
// aquí son UTILITY con razón, y la tercera es MARKETING también con razón:
//
//   open_quote         → UTILITY. Es el seguimiento de un presupuesto
//                        CONCRETO que esa persona pidió. Hay una
//                        transacción identificable detrás.
//   service_anniversary→ UTILITY. Es el recordatorio de una revisión de un
//                        equipo que instalamos nosotros, con su fecha.
//   dormant            → MARKETING, y no hay forma honesta de defender
//                        otra cosa. "Hace tiempo que no sabemos de ti" no
//                        informa de ninguna transacción: es reenganche
//                        comercial. Declararla UTILITY para pagar menos
//                        sería exactamente el tipo de cosa por la que Meta
//                        degrada una cuenta entera.
//
// TODAS LLEVAN EL AVISO DE OPOSICIÓN, y aquí no hay matiz: el marco exige
// identificación del remitente y mecanismo de salida en CADA mensaje
// comercial, no solo en el primero. Se importa de recall-optout.ts en vez
// de reescribirlo para que la redacción legal siga viviendo en un único
// sitio con su número de versión — y para que quien conteste "BAJA" a una
// de estas caiga en el mismo detector que ya existe.
//
// SE ENVÍAN A META SOLAS desde el 2026-09-15: allRecallTemplateDefinitions
// (recall-templates.ts) las incluye, así que salen al conectar WhatsApp y
// ensureRecallTemplatesSubmitted las manda a los negocios ya conectados.
// Hasta que Meta las aprueba, sendTemplate falla con 132001 y la campaña
// registra el fallo por la vía normal. Cambiar un cuerpo ya enviado exige
// un nombre nuevo — ver RECALL_TEMPLATES.callerOpenWithNotice.
// =============================================================================

export interface RecoveryTemplateDefinition {
  name: string;
  languageCode: string;
  category: 'UTILITY' | 'MARKETING';
  bodyText: string;
  bodyExamples: readonly string[];
  /** Cómo se rellenan los {{n}} en el envío. Documentado aquí porque el
   *  orden es un CONTRATO con lo que se envió a Meta: cambiar el número o
   *  el orden de los parámetros falla con 132000 siempre. */
  paramOrder: readonly string[];
}

export const RECOVERY_TEMPLATES: Record<RecoveryTrigger, RecoveryTemplateDefinition> = {
  open_quote: {
    name: 'recovery_open_quote',
    languageCode: 'es',
    category: 'UTILITY',
    // Termina en texto y no en {{n}}: es la regla con la que ya chocamos
    // dos veces al redactar las de recall (error_subcode 2388299).
    bodyText: `Hola{{1}}, te escribimos de {{2}}. Te pasamos un presupuesto hace un tiempo y queríamos saber si sigues interesado o prefieres que lo cerremos. Contéstanos cuando puedas. ${LEGAL_NOTICE_TEXT}`,
    bodyExamples: [' García', 'Fontanería Aurora'],
    paramOrder: ['nombre con espacio delante, o vacío', 'nombre del negocio'],
  },
  service_anniversary: {
    name: 'recovery_service_due',
    languageCode: 'es',
    category: 'UTILITY',
    bodyText: `Hola{{1}}, te escribimos de {{2}}. Según nuestras notas, a tu instalación le toca revisión {{3}}. Si quieres que te busquemos hueco, contéstanos a este mensaje. ${LEGAL_NOTICE_TEXT}`,
    bodyExamples: [' García', 'Fontanería Aurora', 'este mes'],
    paramOrder: ['nombre con espacio delante, o vacío', 'nombre del negocio', 'cuándo vence'],
  },
  dormant: {
    name: 'recovery_dormant',
    languageCode: 'es',
    // Ver la cabecera: esto es reenganche comercial y se declara como tal.
    category: 'MARKETING',
    bodyText: `Hola{{1}}, te escribimos de {{2}}. Hace tiempo que no nos vemos y queríamos recordarte que seguimos aquí por si necesitas algo. ${LEGAL_NOTICE_TEXT}`,
    bodyExamples: [' García', 'Fontanería Aurora'],
    paramOrder: ['nombre con espacio delante, o vacío', 'nombre del negocio'],
  },
};

/**
 * El primer parámetro de las tres plantillas.
 *
 * Va con el espacio incorporado y NO como "Hola {{1}}," porque un contacto
 * sin nombre dejaría "Hola , te escribimos": Meta rechaza un parámetro
 * vacío, y aunque lo aceptara, esa coma suelta es exactamente lo que
 * delata un envío automático mal hecho. Con el espacio dentro del
 * parámetro, sin nombre queda "Hola, te escribimos de…", que se lee bien.
 */
export function greetingParam(name: string | null): string {
  const clean = name?.trim();
  if (!clean) return '';
  // Solo el nombre de pila: el apellido en un saludo automático suena a
  // carta del banco, no a tu fontanero.
  return ` ${clean.split(/\s+/)[0]}`;
}

/** Los parámetros de una plantilla, en el orden con el que se envió a Meta. */
export function buildRecoveryParams(
  trigger: RecoveryTrigger,
  input: { contactName: string | null; businessName: string; dueDescription?: string },
): string[] {
  const base = [greetingParam(input.contactName), input.businessName];
  if (trigger === 'service_anniversary') {
    // Nunca vacío: Meta rechaza el envío entero si un parámetro va en
    // blanco, y "próximamente" es peor promesa que ninguna pero mejor que
    // un mensaje que no sale.
    return [...base, input.dueDescription?.trim() || 'próximamente'];
  }
  return base;
}

export const RECOVERY_TEMPLATE_DEFINITIONS: readonly RecoveryTemplateDefinition[] =
  Object.values(RECOVERY_TEMPLATES);
