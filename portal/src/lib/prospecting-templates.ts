import 'server-only';
import { PROSPECTING_TEMPLATES } from './prospecting-contact';
import { createMessageTemplate } from './whatsapp-api';
import { logError } from './observability';
import type { TemplateSubmissionOutcome } from './recall-templates';

// =============================================================================
// 2026-09-14 — texto real para las 3 plantillas de "Prospección con IA"
// (prospecting_first_contact, prospecting_follow_up_1, prospecting_follow_up_2),
// que hasta ahora solo existían como nombre + qué significa cada {{n}} —
// ver PROSPECTING_TEMPLATES en prospecting-contact.ts. Mismo molde que
// recall-templates.ts (name/language importados de la constante que ya
// usa sendTemplate, para que la sumisión nunca pueda desincronizarse de
// lo que de verdad se envía).
//
// CATEGORÍA: MARKETING, no UTILITY. Es la diferencia real con las 7+2 de
// recall: esas siempre le hablan a alguien con una relación ya abierta
// (llamó al negocio, o es el propio cliente de Kairikos); estas tres son
// el primer contacto en frío con un negocio encontrado por Google Places
// que nunca ha oído hablar del remitente. Enviarlas como UTILITY
// incumpliría la política de contenido de Meta para esa categoría
// (informativo, ligado a una relación existente) y arriesgaría el
// rechazo de las tres. El filtro de consentimiento ya construido
// (PROSPECTING_CONSENT_VERSION, ver prospecting-contact.ts) es requisito
// del propio producto, no sustituye la categoría correcta en Meta.
//
// TEXTO REDACTADO PARA ESTA TAREA, primer borrador — que lo lea quien
// tenga la voz del producto antes de que un cliente dependa de él. Las
// tres evitan terminar en una variable y mantienen una proporción
// palabras/variables razonable, las dos reglas de Meta que ya rechazaron
// borradores de recall en vivo (error_subcode 2388293 y 2388299 — ver
// recall-templates.ts). Las dos de seguimiento ofrecen explícitamente
// dejar de escribir si no hay interés — no hay botón de "dejar de
// recibir" porque sendTemplate/TemplateSpec no soporta botones de
// respuesta rápida todavía, solo el de URL; esta frase es el sustituto
// de contenido mientras tanto.
//
// UNVERIFIED AGAINST A REAL WABA — igual que recall-templates.ts.
// =============================================================================

export interface ProspectingTemplateDefinition {
  name: string;
  languageCode: string;
  category: 'MARKETING';
  bodyText: string;
  /** Meta requires one example per {{n}} placeholder, in order. */
  bodyExamples: readonly string[];
}

export const PROSPECTING_TEMPLATE_DEFINITIONS: readonly ProspectingTemplateDefinition[] = [
  {
    ...PROSPECTING_TEMPLATES.firstContact,
    category: 'MARKETING',
    bodyText:
      'Hola {{1}}, soy {{2}}. Vimos tu negocio y creemos que podríamos ayudarte a conseguir más clientes. ¿Te interesa que te contemos cómo, sin compromiso?',
    bodyExamples: ['Ferretería Central', 'Reformas Orly'],
  },
  {
    ...PROSPECTING_TEMPLATES.followUp1,
    category: 'MARKETING',
    bodyText:
      'Hola de nuevo, {{1}}. Somos {{2}} — te escribimos hace unos días. Si te interesa hablar, seguimos aquí; si no, no volvemos a escribirte.',
    bodyExamples: ['Ferretería Central', 'Reformas Orly'],
  },
  {
    ...PROSPECTING_TEMPLATES.followUp2,
    category: 'MARKETING',
    bodyText: 'Última vez que te escribimos, {{1}}. Somos {{2}}, seguimos disponibles si en algún momento te interesa. ¡Que vaya bien!',
    bodyExamples: ['Ferretería Central', 'Reformas Orly'],
  },
];

/**
 * Submits all 3 prospecting templates to one WABA. Same never-throw,
 * never-stop-early contract as submitAllRecallTemplates — a rejection on
 * one must not cost the other two their submission.
 *
 * Unlike recall, nothing calls this automatically yet: recall's
 * equivalent runs inside connectRecallWhatsapp, recall's own per-client
 * WABA-connect step, which prospecting has no counterpart of (it reuses
 * whichever MetaChannelConnection the client already has for
 * 'whatsapp' — see prospecting-contact.ts). Wiring an automatic trigger
 * is a separate decision; this function exists so a submission (manual,
 * cron, or future trigger) has one correct place to call.
 */
export async function submitAllProspectingTemplates(
  accessToken: string,
  wabaId: string,
): Promise<TemplateSubmissionOutcome[]> {
  const outcomes: TemplateSubmissionOutcome[] = [];
  for (const def of PROSPECTING_TEMPLATE_DEFINITIONS) {
    const result = await createMessageTemplate(accessToken, wabaId, {
      name: def.name,
      languageCode: def.languageCode,
      category: def.category,
      bodyText: def.bodyText,
      bodyExamples: def.bodyExamples,
    });
    if (result.ok) {
      outcomes.push({ name: def.name, ok: true, status: result.data.status });
    } else {
      logError('prospecting_templates.submit_failed', new Error(result.error), { wabaId, template: def.name }, 'warn');
      outcomes.push({ name: def.name, ok: false, error: result.error });
    }
  }
  return outcomes;
}
