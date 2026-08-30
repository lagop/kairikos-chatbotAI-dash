import 'server-only';
import { RECALL_TEMPLATES } from './recall-messaging';
import { DIGEST_TEMPLATES } from './recall-digest';
import { REPORT_TEMPLATE } from './recall-reports';
import { createMessageTemplate } from './whatsapp-api';
import { logError } from './observability';

// =============================================================================
// WP-XX — submits recall's 6 WhatsApp templates to a client's own WABA the
// first time it connects, instead of an operator re-typing them into Meta
// Business Manager for every new client.
//
// The name/language pairs are NOT redefined here — they're imported from
// RECALL_TEMPLATES/DIGEST_TEMPLATES/REPORT_TEMPLATE, the same constants
// sendTemplate's callers use, so submission can never name-drift from what
// is actually sent. Only the body copy and category, which sendTemplate's
// callers have no need to know, live here.
//
// BODY TEXT WAS AUTHORED FOR THIS TASK, NOT CARRIED OVER FROM ANY EXISTING
// SPEC — no template wording existed anywhere in the repo before this
// (only names, languages, and {{n}} meanings, as comments). Treat this
// copy as a first draft: it matches the documented placeholder meanings
// and follows Meta's UTILITY-template content rules (informational,
// tied to an existing customer relationship, no promotional language),
// but real customers see it verbatim and Meta reviews the exact wording —
// have whoever owns the product voice read it before the first client
// goes live.
//
// UNVERIFIED AGAINST A REAL META APP — same standing caveat as
// meta-business.ts and whatsapp-api.ts.
// =============================================================================

export interface RecallTemplateDefinition {
  name: string;
  languageCode: string;
  category: 'UTILITY';
  bodyText: string;
  /** Meta requires one example per {{n}} placeholder, in order. */
  bodyExamples: readonly string[];
}

// buildDigestList (recall-digest.ts) joins entries with ' · ', never a
// newline — the examples below match that shape rather than showing a
// line break Meta would never actually see.
export const RECALL_TEMPLATE_DEFINITIONS: readonly RecallTemplateDefinition[] = [
  {
    ...RECALL_TEMPLATES.callerOpen,
    category: 'UTILITY',
    bodyText:
      'Hola, soy el asistente de {{1}}. Vimos tu llamada y no pudimos contestar — te escribimos en cuanto podamos.',
    bodyExamples: ['Peluquería Aurora'],
  },
  {
    ...RECALL_TEMPLATES.callerClosed,
    category: 'UTILITY',
    bodyText:
      'Hola, soy el asistente de {{1}}. Ahora mismo estamos cerrados, abrimos {{2}}. En cuanto abramos te contestamos.',
    bodyExamples: ['Peluquería Aurora', 'mañana a las 9:00'],
  },
  {
    ...RECALL_TEMPLATES.ownerMessage,
    category: 'UTILITY',
    bodyText: 'Recado de {{1}}: {{2}}',
    bodyExamples: ['+34611223344', 'Quiere reservar cita para el sábado por la mañana'],
  },
  {
    ...DIGEST_TEMPLATES.daily,
    category: 'UTILITY',
    bodyText:
      'Hoy tuviste {{1}} llamadas perdidas: {{2}}. Responde con el número de la llamada para marcarla como gestionada.',
    bodyExamples: ['3', '1) 611223344 – Quiere reservar cita · 2) número oculto – sin recado'],
  },
  {
    ...DIGEST_TEMPLATES.clarify,
    category: 'UTILITY',
    bodyText: 'No entendí tu respuesta. ¿A cuál de estas llamadas te refieres? {{1}}',
    bodyExamples: ['1) 611223344 – Quiere reservar cita · 2) 622334455 – Pregunta por horario'],
  },
  {
    ...REPORT_TEMPLATE,
    category: 'UTILITY',
    bodyText: 'Tu resumen de {{1}}: {{2}} llamadas recuperadas, {{3}} contactadas, {{4}} reseñas nuevas (valoración media {{5}}).',
    bodyExamples: ['agosto', '12', '10', '3', '4.8'],
  },
];

export interface TemplateSubmissionOutcome {
  name: string;
  ok: boolean;
  error?: string;
  /** Meta's immediate placement — see createMessageTemplate's header. */
  status?: string;
}

/**
 * Submits every recall template to one WABA, one at a time.
 *
 * Never throws and never stops early: a template Meta rejects (bad
 * wording, missing example) or that already exists on this WABA from a
 * previous connect must not cost the other five their submission — same
 * "one bad row must never cost everyone else" discipline as
 * sweepPendingNotifications (recall-messaging.ts).
 */
export async function submitAllRecallTemplates(
  accessToken: string,
  wabaId: string,
): Promise<TemplateSubmissionOutcome[]> {
  const outcomes: TemplateSubmissionOutcome[] = [];
  for (const def of RECALL_TEMPLATE_DEFINITIONS) {
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
      logError('recall_templates.submit_failed', new Error(result.error), { wabaId, template: def.name }, 'warn');
      outcomes.push({ name: def.name, ok: false, error: result.error });
    }
  }
  return outcomes;
}
