import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { RECALL_TEMPLATES, metaSenderFor } from './recall-messaging';
import { DIGEST_TEMPLATES } from './recall-digest';
import { REPORT_TEMPLATE } from './recall-reports';
import { createMessageTemplate, sendTemplate, isAccessTokenError } from './whatsapp-api';
import { markConnectionNeedsReconnect } from './whatsapp-health';
import { LEGAL_NOTICE_TEXT } from './recall-optout';
import { REVIEW_TEMPLATE } from './review-request-campaign';
import { RECOVERY_TEMPLATE_DEFINITIONS } from './recovery-templates';
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
  category: 'UTILITY' | 'MARKETING';
  bodyText: string;
  /** Meta requires one example per {{n}} placeholder, in order. */
  bodyExamples: readonly string[];
  /** Ver createMessageTemplate. Solo la invitación a reseña lo usa. */
  urlButton?: { text: string; url: string; example: string };
}

// buildDigestList (recall-digest.ts) joins entries with ' · ', never a
// newline — the examples below match that shape rather than showing a
// line break Meta would never actually see.
export const RECALL_TEMPLATE_DEFINITIONS: readonly RecallTemplateDefinition[] = [
  // Fase 0 — LAS TRES PLANTILLAS DE PRIMER CONTACTO LLEVAN EL AVISO DE
  // OPOSICIÓN PEGADO AL FINAL, y es obligatorio que sigan llevándolo: es
  // el único momento en el que se le da a esa persona la opción de
  // oponerse, y sin ella los números que se acumulan no sirven después
  // para nada (ver la cabecera de recall-optout.ts). Hay un test que lo
  // vigila — si lo quitas, la suite se pone roja a propósito.
  //
  // El texto se importa en vez de escribirse aquí para que la redacción
  // legal viva en un solo sitio, junto a su número de versión.
  //
  // Efecto lateral agradecido: añadir una frase al final MEJORA las dos
  // reglas de Meta con las que ya chocamos —sube la proporción de
  // palabras por variable (2388293) y garantiza que la plantilla no
  // termina en {{n}} (2388299)—, así que este cambio no acerca ningún
  // rechazo, aleja dos.
  //
  // Fase 0 bis — CON NOMBRE NUEVO (_v2), y la lección cuesta cara: la
  // primera vez se cambió el texto conservando el nombre, pero esas
  // plantillas ya estaban aprobadas en Meta con el texto antiguo, y en
  // WhatsApp solo viaja el cuerpo aprobado. El código creía enviar el aviso
  // y no lo enviaba. REGLA: cambiar el cuerpo de una plantilla que ya puede
  // estar aprobada exige un nombre nuevo, nunca reutilizar el anterior.
  // Los nombres antiguos quedan solo como respaldo de envío en
  // recall-messaging.ts (CALLER_TEMPLATE_VARIANTS), y ya no se envían a Meta.
  {
    ...RECALL_TEMPLATES.callerOpenWithNotice,
    category: 'UTILITY',
    bodyText: `Hola, soy el asistente de {{1}}. Vimos tu llamada y no pudimos contestar — te escribimos en cuanto podamos. ${LEGAL_NOTICE_TEXT}`,
    bodyExamples: ['Peluquería Aurora'],
  },
  {
    ...RECALL_TEMPLATES.callerClosedWithNotice,
    category: 'UTILITY',
    bodyText: `Hola, soy el asistente de {{1}}. Ahora mismo estamos cerrados, abrimos {{2}}. En cuanto abramos te contestamos. ${LEGAL_NOTICE_TEXT}`,
    bodyExamples: ['Peluquería Aurora', 'mañana a las 9:00'],
  },
  {
    ...RECALL_TEMPLATES.ownerMessage,
    category: 'UTILITY',
    // Meta rejected the original 'Recado de {{1}}: {{2}}' — too high a
    // variable-to-word ratio (error_subcode 2388293). The first fix still
    // ended on {{2}} with nothing after it, which trips the separate
    // "variable cannot be first or last" rule (error_subcode 2388299) —
    // both found submitting live against a real WABA.
    bodyText: 'Tienes un recado nuevo. Te llamó {{1}} y dijo: {{2}}. Contesta cuando puedas.',
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
    // Meta rejected the original '...te refieres? {{1}}' — a variable
    // cannot be the last thing in the template (error_subcode 2388299,
    // "No se permite incluir parámetros al principio ni al final"),
    // found submitting live against a real WABA.
    bodyText: 'No entendí tu respuesta. Estas son las llamadas de hoy: {{1}}. ¿Cuál de ellas quieres marcar?',
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

// 2026-09-14 — recall_caller_slots y recall_owner_callback: las dos
// plantillas que faltaban por redactar (existían desde Fase 3 solo como
// nombre + qué significa cada {{n}}, nunca con texto — ver
// RECALL_TEMPLATES en recall-messaging.ts).
//
// Van en un array APARTE, no añadidas a RECALL_TEMPLATE_DEFINITIONS, a
// propósito: REQUIRED_TEMPLATE_NAMES (más abajo) se deriva de ese array
// para decidir cuándo un onboarding pasa a `forwarding_pending`, y estas
// dos NO son parte del flujo obligatorio — callerSlots solo se manda si
// el negocio está cerrado Y tiene huecos que ofrecer, ownerCallback solo
// si hay una devolución de llamada programada. Añadirlas al array
// original habría exigido su aprobación para completar el alta de TODO
// cliente, aunque nunca las llegue a usar. submitAllRecallTemplates (más
// abajo) las manda igualmente a revisión, solo que sin bloquear nada.
//
// Mismo aviso que la cabecera de arriba: primer borrador, sin probar
// contra un WABA real todavía — que lo lea quien tenga la voz del
// producto antes de que un cliente dependa de ellas.
export const RECALL_OPTIONAL_TEMPLATE_DEFINITIONS: readonly RecallTemplateDefinition[] = [
  {
    ...RECALL_TEMPLATES.callerSlotsWithNotice,
    category: 'UTILITY',
    // Lleva el aviso como las otras dos de primer contacto: para mucha
    // gente ESTE es el primer mensaje que recibe, no un segundo toque.
    bodyText: `Hola, soy el asistente de {{1}}. Ahora mismo estamos cerrados. Si quieres, te devolvemos la llamada en uno de estos horarios: {{2}}. Responde con el número que prefieras. ${LEGAL_NOTICE_TEXT}`,
    bodyExamples: ['Peluquería Aurora', '1) hoy a las 17:30 · 2) mañana a las 9:00'],
  },
  {
    ...RECALL_TEMPLATES.ownerCallback,
    category: 'UTILITY',
    bodyText: 'Recordatorio: te toca devolver la llamada a {{1}} {{2}}. Avísanos si ya no hace falta.',
    bodyExamples: ['+34611223344', 'a las 9:00'],
  },
];

// =============================================================================
// 2026-09-15 — las plantillas que el producto YA enviaba sin haberlas
// mandado nunca a Meta.
//
// recall_review_request (review-request-campaign.ts) y las tres recovery_*
// (recovery-templates.ts) tenían nombre y código de envío, pero nadie las
// había enviado a revisión: cada envío real habría fallado con 132001
// (plantilla inexistente). Se suman aquí, a la lista que se envía al
// conectar y a la que ensureRecallTemplatesSubmitted repasa en cada ciclo.
// No bloquean el alta, igual que las opcionales.
//
// recall_review_request se declara MARKETING a propósito, con el mismo
// criterio que recovery_dormant: pedir una reseña no informa de ninguna
// transacción, pide un favor comercial. Declararla UTILITY para pagar menos
// es lo que hace que Meta rebaje la calidad de una cuenta entera. Lleva el
// aviso de oposición por la misma razón.
//
// SU BOTÓN APUNTA A UNA URL FIJA EN META: `<portal>/r/{{1}}`. Si el dominio
// del portal cambia, las invitaciones ya aprobadas siguen apuntando al
// antiguo hasta que se envíe una versión nueva con otro nombre. Por eso sin
// NEXT_PUBLIC_PORTAL_URL no se envía: una URL adivinada quedaría grabada.
// =============================================================================

export function reviewRequestTemplateDefinition(portalUrl: string | undefined): RecallTemplateDefinition | null {
  const base = portalUrl?.trim().replace(/\/+$/, '');
  if (!base || !/^https:\/\//.test(base)) return null;
  return {
    ...REVIEW_TEMPLATE,
    category: 'MARKETING',
    bodyText: `Hola, gracias por confiar en {{1}}. Si tienes un minuto, nos ayudaría mucho que dejaras tu opinión en Google: solo tienes que pulsar el botón de abajo. ${LEGAL_NOTICE_TEXT}`,
    bodyExamples: ['Peluquería Aurora'],
    urlButton: { text: 'Dejar una reseña', url: `${base}/r/{{1}}`, example: `${base}/r/cm0example0001` },
  };
}

/** Todo lo que un negocio de recall necesita tener en Meta, obligatorio o
 *  no. Una función y no una constante porque la invitación a reseña
 *  depende del dominio del portal, que se lee al usarla. */
export function allRecallTemplateDefinitions(
  portalUrl: string | undefined = process.env.NEXT_PUBLIC_PORTAL_URL,
): RecallTemplateDefinition[] {
  const review = reviewRequestTemplateDefinition(portalUrl);
  return [
    ...RECALL_TEMPLATE_DEFINITIONS,
    ...RECALL_OPTIONAL_TEMPLATE_DEFINITIONS,
    ...(review ? [review] : []),
    // paramOrder se queda en recovery-templates.ts: es contrato del envío,
    // no algo que Meta reciba.
    ...RECOVERY_TEMPLATE_DEFINITIONS.map(({ name, languageCode, category, bodyText, bodyExamples }) => ({
      name,
      languageCode,
      category,
      bodyText,
      bodyExamples,
    })),
  ];
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
  accessToken: string,
  wabaId: string,
): Promise<TemplateSubmissionOutcome[]> {
  const outcomes: TemplateSubmissionOutcome[] = [];
  for (const def of allRecallTemplateDefinitions()) {
    const result = await createMessageTemplate(accessToken, wabaId, {
      name: def.name,
      languageCode: def.languageCode,
      category: def.category,
      bodyText: def.bodyText,
      bodyExamples: def.bodyExamples,
      ...(def.urlButton ? { urlButton: def.urlButton } : {}),
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

// =============================================================================
// Fase 0 bis — enviar a Meta las plantillas que le falten a un negocio que
// YA estaba dado de alta.
//
// submitAllRecallTemplates solo se ejecuta al conectar WhatsApp. Cuando una
// plantilla cambia de nombre —como las de primer contacto al pasar a _v2—
// los negocios conectados antes no la reciben nunca por esa vía. Este
// barrido cierra ese hueco: cada ciclo, compara las definiciones actuales
// con el espejo de plantillas de cada negocio y envía las que falten.
//
// EL RESULTADO DEL ENVÍO SE GUARDA EN EL ESPEJO AL MOMENTO, salga bien o mal:
//
//   · bien  → fila con el estado que devuelve Meta (normalmente PENDING).
//             Sin esto, hasta que syncTemplateStatuses la viera, el ciclo
//             siguiente la volvería a enviar.
//   · mal   → fila con estado SUBMIT_FAILED y el error de Meta. Sin esto,
//             una plantilla que Meta rechaza al crearla se reenviaría cada
//             cinco minutos para siempre. Con la fila, se para, queda a la
//             vista del operador y se reintenta UNA VEZ AL DÍA
//             (SUBMIT_FAILED_RETRY_HOURS).
//   · token → NO se escribe fila. Un token caducado (code 190) no dice nada
//             de la plantilla. El primer despliegue de este barrido, el
//             2026-09-15, marcó las siete plantillas nuevas como
//             SUBMIT_FAILED por eso mismo. Ahora la conexión pasa a
//             needs_reconnect (markConnectionNeedsReconnect) y se deja de
//             intentar con ella.
//
// Si luego Meta sí la tiene, syncTemplateStatuses sobrescribe la fila con el
// estado real: el espejo sigue mandando Meta, no esta función.
// =============================================================================

/** Cada cuánto se reintenta un envío fallido. Un día: si fue la redacción,
 *  un intento diario no molesta a nadie; si fue algo pasajero (el token,
 *  una caída de Meta), se arregla solo sin que nadie borre filas. */
export const SUBMIT_FAILED_RETRY_HOURS = 24;

/** Los nombres que cuentan como "ya enviados" en el espejo: todos, salvo
 *  los SUBMIT_FAILED cuyo último intento tiene más de un día. */
export function namesAlreadySubmitted(
  rows: ReadonlyArray<{ name: string; status: string; lastCheckedAt: Date | null }>,
  now: Date,
): Set<string> {
  const retryBefore = now.getTime() - SUBMIT_FAILED_RETRY_HOURS * 60 * 60 * 1000;
  return new Set(
    rows
      .filter(
        (row) =>
          row.status !== 'SUBMIT_FAILED' || (row.lastCheckedAt !== null && row.lastCheckedAt.getTime() > retryBefore),
      )
      .map((row) => row.name),
  );
}

/** Qué definiciones faltan en un negocio, dado lo que ya hay en su espejo
 *  (con cualquier estado: una rechazada por Meta en revisión no se reenvía
 *  sola, eso lo decide una persona). Pura y exportada para probarla sin
 *  red. */
export function missingTemplateDefinitions(
  existingNames: ReadonlySet<string>,
  portalUrl: string | undefined = process.env.NEXT_PUBLIC_PORTAL_URL,
): RecallTemplateDefinition[] {
  return allRecallTemplateDefinitions(portalUrl).filter((def) => !existingNames.has(def.name));
}

export interface EnsureTemplatesResult {
  connections: number;
  submitted: number;
  failed: number;
}

/** Tope por ciclo. El barrido corre cada cinco minutos: no hace falta
 *  ponerse al día de golpe, y Meta limita la creación de plantillas. */
const MAX_SUBMISSIONS_PER_TICK = 20;

export async function ensureRecallTemplatesSubmitted(
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<EnsureTemplatesResult> {
  const now = opts.now ?? new Date();
  const result: EnsureTemplatesResult = { connections: 0, submitted: 0, failed: 0 };

  const subscriptions = await prisma.recallSubscription.findMany({
    where: { status: { notIn: ['cancelled', 'paid', 'contract_signed'] }, metaConnectionId: { not: null } },
    select: {
      metaConnection: {
        select: {
          id: true,
          clientId: true,
          wabaId: true,
          externalId: true,
          status: true,
          accessTokenCiphertext: true,
          accessTokenIv: true,
          accessTokenTag: true,
        },
      },
    },
  });

  let budget = MAX_SUBMISSIONS_PER_TICK;
  // Dos suscripciones pueden compartir conexión (una baja y un alta nueva
  // del mismo negocio). Sin esto, la segunda leería el espejo antes de que
  // el upsert de la primera fuese visible y reenviaría lo mismo.
  const seen = new Set<string>();

  for (const { metaConnection: connection } of subscriptions) {
    if (budget <= 0) break;
    if (!connection || !connection.wabaId || seen.has(connection.id)) continue;
    seen.add(connection.id);

    const sender = metaSenderFor(connection);
    if (!sender) continue;
    result.connections += 1;

    const existing = await prisma.whatsappTemplate.findMany({
      where: { connectionId: connection.id },
      select: { name: true, status: true, lastCheckedAt: true },
    });
    const missing = missingTemplateDefinitions(namesAlreadySubmitted(existing, now));

    for (const def of missing) {
      if (budget <= 0) break;
      budget -= 1;

      const created = await createMessageTemplate(sender.token, connection.wabaId, {
        name: def.name,
        languageCode: def.languageCode,
        category: def.category,
        bodyText: def.bodyText,
        bodyExamples: def.bodyExamples,
        ...(def.urlButton ? { urlButton: def.urlButton } : {}),
      });

      if (!created.ok && isAccessTokenError(created)) {
        // La conexión está muerta, no la plantilla: sin fila, y ni una
        // llamada más con este token. Ver la cabecera de esta sección.
        await markConnectionNeedsReconnect(prisma, connection.id, created.error, now);
        result.failed += 1;
        break;
      }

      await prisma.whatsappTemplate.upsert({
        where: {
          connectionId_name_languageCode: {
            connectionId: connection.id,
            name: def.name,
            languageCode: def.languageCode,
          },
        },
        create: {
          clientId: connection.clientId,
          connectionId: connection.id,
          name: def.name,
          languageCode: def.languageCode,
          metaTemplateId: created.ok ? (created.data.id ?? null) : null,
          status: created.ok ? (created.data.status ?? 'PENDING') : 'SUBMIT_FAILED',
          category: def.category,
          rejectedReason: created.ok ? null : created.error.slice(0, 500),
          lastCheckedAt: now,
        },
        // Solo se llega aquí con fila previa al reintentar un SUBMIT_FAILED
        // de hace más de un día. Si falla otra vez, no se toca el estado:
        // en la carrera rara con syncTemplateStatuses, el que manda es Meta.
        update: created.ok
          ? {
              metaTemplateId: created.data.id ?? null,
              status: created.data.status ?? 'PENDING',
              rejectedReason: null,
              lastCheckedAt: now,
            }
          : { rejectedReason: created.error.slice(0, 500), lastCheckedAt: now },
      });

      if (created.ok) {
        result.submitted += 1;
      } else {
        result.failed += 1;
        logError(
          'recall_templates.ensure_submit_failed',
          new Error(created.error),
          { connectionId: connection.id, template: def.name },
          'warn',
        );
      }
    }
  }

  return result;
}
