import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { metaSenderFor } from './recall-messaging';
import { createMessageTemplate, sendTemplate } from './whatsapp-api';
import { logError } from './observability';

// =============================================================================
// WP-XX — submits recall's 7 WhatsApp templates to a client's own WABA the
// first time it connects, instead of an operator re-typing them into Meta
// Business Manager for every new client.
//
// The definitions themselves live in Postgres (RecallTemplateDefinition,
// see schema.prisma), editable at /admin/portal/settings/recall-templates
// — this file used to hold them as a hardcoded RECALL_TEMPLATE_DEFINITIONS
// array; that array is now only the migration's seed data (see
// 20260913090000_recall_template_definitions), not read at runtime.
// name/languageCode are NOT editable from that settings UI: other code
// (recall-messaging.ts's RECALL_TEMPLATES, FORWARDING_INSTRUCTIONS_TEMPLATE
// below) references templates BY NAME to send an already-approved one —
// changing a name in the DB without updating those constants would
// silently desync submission from sending, so the settings UI only ever
// touches bodyText/bodyExamples.
//
// BODY TEXT WAS AUTHORED FOR THIS TASK, NOT CARRIED OVER FROM ANY EXISTING
// SPEC — no template wording existed anywhere in the repo before this
// (only names, languages, and {{n}} meanings, as comments). Treat the
// seeded copy as a first draft: it matches the documented placeholder
// meanings and follows Meta's UTILITY-template content rules
// (informational, tied to an existing customer relationship, no
// promotional language), but real customers see it verbatim and Meta
// reviews the exact wording — have whoever owns the product voice read
// it (and edit it via the settings UI if needed) before the first client
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
//
// EDITING A DEFINITION HERE DOES NOT RETROACTIVELY TOUCH ANY CLIENT'S
// ALREADY-APPROVED TEMPLATE ON META'S SIDE — a WABA that already has the
// old wording approved keeps it until that client reconnects. An edit
// only changes what gets submitted to clients who connect AFTER it.
// =============================================================================

/** No other sender exists for this one — see the header. */
export const FORWARDING_INSTRUCTIONS_TEMPLATE = { name: 'recall_forwarding_instructions', languageCode: 'es' } as const;

export interface RecallTemplateSpec {
  name: string;
  languageCode: string;
  category: string;
  bodyText: string;
  /** Meta requires one example per {{n}} placeholder, in order. */
  bodyExamples: readonly string[];
}

/** Reads the 7 template definitions from Postgres, in the product's
 *  fixed display order — never the hardcoded array this file used to
 *  export (see the header). */
export async function getTemplateDefinitions(prisma: PrismaClient): Promise<RecallTemplateSpec[]> {
  const rows = await prisma.recallTemplateDefinition.findMany({ orderBy: { sortOrder: 'asc' } });
  return rows.map((row) => ({
    name: row.name,
    languageCode: row.languageCode,
    category: row.category,
    bodyText: row.bodyText,
    bodyExamples: row.bodyExamples,
  }));
}

/**
 * Enforces Meta's placeholder contract server-side, before a save can
 * ever reach the DB: one example per UNIQUE {{n}} placeholder (a
 * repeated placeholder still needs only one), numbered sequentially from
 * {{1}} with no gaps. A save that violates this doesn't fail loudly at
 * submission time — it fails PERMANENTLY on every send after Meta
 * approves the mismatched version (error 132000, not reintentable) — see
 * this file's header and the settings route's own comment.
 */
export function validateTemplateBody(
  bodyText: string,
  bodyExamples: readonly string[],
): { ok: true } | { ok: false; error: string } {
  const placeholders = [...new Set(bodyText.match(/\{\{\d+\}\}/g) ?? [])];
  if (placeholders.length !== bodyExamples.length) {
    return {
      ok: false,
      error: `El texto tiene ${placeholders.length} variable(s) única(s) (${placeholders.join(', ') || 'ninguna'}), pero se dieron ${bodyExamples.length} ejemplo(s). Deben coincidir exactamente.`,
    };
  }
  const numbers = placeholders.map((p) => Number(p.slice(2, -2))).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i++) {
    if (numbers[i] !== i + 1) {
      return {
        ok: false,
        error: `Las variables deben numerarse {{1}}, {{2}}, ... sin huecos. Encontrado: ${numbers.map((n) => `{{${n}}}`).join(', ') || 'ninguna'}.`,
      };
    }
  }
  if (bodyExamples.some((ex) => !ex.trim())) {
    return { ok: false, error: 'Ningún ejemplo puede quedar vacío.' };
  }
  return { ok: true };
}

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
  prisma: PrismaClient,
  accessToken: string,
  wabaId: string,
): Promise<TemplateSubmissionOutcome[]> {
  const definitions = await getTemplateDefinitions(prisma);
  const outcomes: TemplateSubmissionOutcome[] = [];
  for (const def of definitions) {
    const result = await createMessageTemplate(accessToken, wabaId, {
      name: def.name,
      languageCode: def.languageCode,
      // category is TEXT in the DB (not editable from the settings UI,
      // always seeded as 'UTILITY' — see the migration) — narrowed here
      // rather than in the DB column so a genuinely unexpected value
      // fails loudly against Meta's API instead of silently at the type
      // level.
      category: def.category as 'UTILITY' | 'MARKETING' | 'AUTHENTICATION',
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
  const requiredNames = (await prisma.recallTemplateDefinition.findMany({ select: { name: true } })).map(
    (row) => row.name,
  );

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
        name: { in: requiredNames },
        status: 'APPROVED',
      },
    });
    if (approvedCount < requiredNames.length) continue;

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
