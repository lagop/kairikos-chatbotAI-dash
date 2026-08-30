import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { RECALL_TEMPLATES, metaSenderFor } from './recall-messaging';
import { DIGEST_TEMPLATES } from './recall-digest';
import { REPORT_TEMPLATE } from './recall-reports';
import { createMessageTemplate, sendTemplate } from './whatsapp-api';
import { logError } from './observability';

// =============================================================================
// WP-XX — submits recall's 7 WhatsApp templates to a client's own WABA the
// first time it connects, instead of an operator re-typing them into Meta
// Business Manager for every new client.
//
// The name/language pairs for the first 6 are NOT redefined here — they're
// imported from RECALL_TEMPLATES/DIGEST_TEMPLATES/REPORT_TEMPLATE, the same
// constants sendTemplate's callers use, so submission can never name-drift
// from what is actually sent. The 7th, FORWARDING_INSTRUCTIONS_TEMPLATE,
// has no other sender — it belongs here, next to the only function that
// ever sends it (advanceSubscriptionsWithApprovedTemplates, below).
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
// FORWARDING_INSTRUCTIONS_TEMPLATE IS A DIFFERENT CLASS OF RISK FROM THE
// OTHER 6: it contains real GSM call-forwarding (MMI) codes, and a wrong
// code silently breaks the product for a paying client rather than just
// reading awkwardly. No such codes existed anywhere in this repo before
// this — the closest prior art was two bare fragments (`##61#` in
// recall.ts's cancel comment, `**61*` in recall-calls.ts's forwarding
// comment). The three codes used here (**61*, **67*, **62* — no-answer,
// busy, unreachable) are the standard GSM/3GPP conditional-forwarding
// codes, chosen deliberately over unconditional forwarding (**21*)
// because this product should only intercept calls the client could not
// take himself. They are consistent with both of those existing
// fragments and with recall.ts's own "three MMI codes" description, but
// are UNVERIFIED AGAINST A REAL PHONE LINE — test against one real
// number before relying on this for a paying client.
//
// UNVERIFIED AGAINST A REAL META APP — same standing caveat as
// meta-business.ts and whatsapp-api.ts.
// =============================================================================

/** No other sender exists for this one — see the header. */
export const FORWARDING_INSTRUCTIONS_TEMPLATE = { name: 'recall_forwarding_instructions', languageCode: 'es' } as const;

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
  {
    ...FORWARDING_INSTRUCTIONS_TEMPLATE,
    category: 'UTILITY',
    bodyText:
      'Para activar el desvío de llamadas a tu línea de Kairikos, marca estos 3 códigos desde tu móvil (uno detrás de otro, pulsando llamar después de cada uno):\n\n1) **61*{{1}}#\n2) **67*{{1}}#\n3) **62*{{1}}#\n\nTu teléfono sigue funcionando igual que siempre — solo se desvían las llamadas que no coges, comunicas o no tienen cobertura.',
    bodyExamples: ['+34910123456'],
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

const REQUIRED_TEMPLATE_NAMES = RECALL_TEMPLATE_DEFINITIONS.map((def) => def.name);

/**
 * Advances every `number_assigned` subscription whose bound connection
 * now has all 7 required templates APPROVED (the 6 messaging ones plus
 * FORWARDING_INSTRUCTIONS_TEMPLATE) through `templates_approved` and
 * straight on to `forwarding_pending` — sending the forwarding
 * instructions as the same act, per recall.ts's own comment on why
 * forwarding_pending has no separate timestamp column ("entered by the
 * same act that approved the templates").
 *
 * The missing half of the gap this module exists to close: submission
 * (submitAllRecallTemplates, above) puts templates in front of Meta's
 * reviewers; this is what notices they came back approved.
 * syncTemplateStatuses (whatsapp-health.ts) already polls Meta and
 * mirrors each template's status into WhatsappTemplate every ~5 minutes
 * — this function only reads that table, it never calls Meta itself, so
 * it belongs right after that sync in the same cron tick (recall-tick).
 *
 * WhatsappTemplate has no direct relation to RecallSubscription — the
 * join is subscription.metaConnectionId → WhatsappTemplate.connectionId.
 *
 * The forwarding_pending advance happens REGARDLESS of whether the
 * WhatsApp send succeeds — same posture as every other best-effort step
 * in this product (connectRecallWhatsapp's subscribeWaba/syncSmbAppState):
 * the state fact (templates are approved, onboarding should proceed) is
 * independent of a notification's delivery. A send failure here still
 * surfaces to an operator within a day via notifyStuckOnboardings, since
 * forwarding_pending's own STUCK_AFTER_DAYS threshold is 1.
 */
export async function advanceSubscriptionsWithApprovedTemplates(
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<{ advanced: number }> {
  const now = opts.now ?? new Date();

  const candidates = await prisma.recallSubscription.findMany({
    where: { status: 'number_assigned', metaConnectionId: { not: null } },
    select: {
      id: true,
      clientId: true,
      status: true,
      metaConnectionId: true,
      ownerWhatsapp: true,
      virtualNumber: { select: { e164: true } },
      metaConnection: {
        select: {
          id: true,
          externalId: true,
          status: true,
          accessTokenCiphertext: true,
          accessTokenIv: true,
          accessTokenTag: true,
        },
      },
    },
  });

  let advanced = 0;
  for (const subscription of candidates) {
    if (!subscription.metaConnectionId) continue;

    const approvedCount = await prisma.whatsappTemplate.count({
      where: {
        connectionId: subscription.metaConnectionId,
        name: { in: REQUIRED_TEMPLATE_NAMES },
        status: 'APPROVED',
      },
    });
    if (approvedCount < REQUIRED_TEMPLATE_NAMES.length) continue;

    const before = { status: subscription.status };
    const updated = await prisma.recallSubscription.update({
      where: { id: subscription.id },
      data: { status: 'templates_approved', templatesApprovedAt: now },
      select: { status: true },
    });

    await prisma.recallSubscriptionAudit
      .create({
        data: {
          subscriptionId: subscription.id,
          clientId: subscription.clientId,
          action: 'templates_approved',
          before,
          after: { status: updated.status },
          actorType: 'system',
          actorEmail: 'system:whatsapp_health',
        },
      })
      // The advance already happened — an audit-insert failure must not
      // undo it or get retried as if the transition never occurred.
      .catch(() => null);

    const sender = metaSenderFor(subscription.metaConnection);
    const virtualNumber = subscription.virtualNumber?.e164;
    if (sender && virtualNumber && subscription.ownerWhatsapp) {
      const sent = await sendTemplate(sender.token, sender.phoneNumberId, subscription.ownerWhatsapp, {
        ...FORWARDING_INSTRUCTIONS_TEMPLATE,
        bodyParams: [virtualNumber],
      });
      if (!sent.ok) {
        logError('recall_templates.forwarding_instructions_send_failed', new Error(sent.error), { subscriptionId: subscription.id }, 'warn');
      }
    } else {
      logError(
        'recall_templates.forwarding_instructions_send_skipped',
        new Error('missing sender, virtual number, or owner WhatsApp'),
        { subscriptionId: subscription.id },
        'warn',
      );
    }

    const advancedFurther = await prisma.recallSubscription.update({
      where: { id: subscription.id },
      data: { status: 'forwarding_pending' },
      select: { status: true },
    });

    await prisma.recallSubscriptionAudit
      .create({
        data: {
          subscriptionId: subscription.id,
          clientId: subscription.clientId,
          action: 'forwarding_pending',
          before: { status: updated.status },
          after: { status: advancedFurther.status },
          actorType: 'system',
          actorEmail: 'system:whatsapp_health',
        },
      })
      .catch(() => null);

    advanced += 1;
  }

  return { advanced };
}
