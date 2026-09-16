import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { PROSPECTING_TEMPLATES } from './prospecting-contact';
import { createMessageTemplate, isAccessTokenError } from './whatsapp-api';
import { metaSenderFor } from './recall-messaging';
import { markConnectionNeedsReconnect } from './whatsapp-health';
import { namesAlreadySubmitted, type TemplateSubmissionOutcome } from './recall-templates';
import { logError } from './observability';

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

// =============================================================================
// 2026-09-16 — el disparador automático que faltaba (ver el comentario de
// submitAllProspectingTemplates, arriba: "wiring an automatic trigger is a
// separate decision"). Mismo molde que ensureRecallTemplatesSubmitted
// (recall-templates.ts): un barrido idempotente, tope por ciclo, que
// nunca reenvía lo que ya está en el espejo WhatsappTemplate y nunca deja
// que el rechazo de una plantilla, o de un cliente, le cueste el turno a
// los demás.
//
// Se envía para toda campaña `active`, no solo las que ya dieron consentimiento
// de contacto (consentAcknowledgedAt) — al revés que runProspectingContact.
// La revisión de Meta tarda; someter la plantilla en cuanto hay conexión de
// WhatsApp, en vez de esperar a que el cliente dé el consentimiento, es lo
// que evita que ese trámite se convierta en el cuello de botella justo
// cuando el cliente por fin consiente.
//
// namesAlreadySubmitted se reutiliza tal cual de recall-templates.ts — es
// genérica (opera sobre filas name/status/lastCheckedAt), no específica de
// recall — en vez de duplicar la misma ventana de reintento de 24h aquí.
// =============================================================================

/** Tope por ciclo, misma razón que recall-templates.ts: el barrido corre
 *  cada vez que pasa prospecting-tick y Meta limita la creación de
 *  plantillas. */
const MAX_SUBMISSIONS_PER_TICK = 20;

export interface EnsureProspectingTemplatesResult {
  connections: number;
  submitted: number;
  failed: number;
}

/** Qué definiciones faltan en una conexión, dado lo que ya hay en su
 *  espejo. Pura y exportada para probarla sin red — mismo patrón que
 *  missingTemplateDefinitions en recall-templates.ts. */
export function missingProspectingTemplateDefinitions(
  existingNames: ReadonlySet<string>,
): ProspectingTemplateDefinition[] {
  return PROSPECTING_TEMPLATE_DEFINITIONS.filter((def) => !existingNames.has(def.name));
}

export async function ensureProspectingTemplatesSubmitted(
  prisma: PrismaClient,
  opts: { now?: Date } = {},
): Promise<EnsureProspectingTemplatesResult> {
  const now = opts.now ?? new Date();
  const result: EnsureProspectingTemplatesResult = { connections: 0, submitted: 0, failed: 0 };

  const campaigns = await prisma.prospectingCampaign.findMany({
    where: { status: 'active' },
    select: { clientId: true },
  });
  const clientIds = [...new Set(campaigns.map((c) => c.clientId))];
  if (clientIds.length === 0) return result;

  // Misma conexión que runProspectingContact resuelve (prospecting-contact.ts):
  // el canal 'whatsapp' activo del cliente, no una tabla propia de prospección.
  const connections = await prisma.metaChannelConnection.findMany({
    where: { clientId: { in: clientIds }, channel: 'whatsapp', status: 'active' },
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
  });

  let budget = MAX_SUBMISSIONS_PER_TICK;

  for (const connection of connections) {
    if (budget <= 0) break;
    if (!connection.wabaId) continue;

    const sender = metaSenderFor(connection);
    if (!sender) continue;
    result.connections += 1;

    const existing = await prisma.whatsappTemplate.findMany({
      where: { connectionId: connection.id },
      select: { name: true, status: true, lastCheckedAt: true },
    });
    const missing = missingProspectingTemplateDefinitions(namesAlreadySubmitted(existing, now));

    for (const def of missing) {
      if (budget <= 0) break;
      budget -= 1;

      const created = await createMessageTemplate(sender.token, connection.wabaId, {
        name: def.name,
        languageCode: def.languageCode,
        category: def.category,
        bodyText: def.bodyText,
        bodyExamples: def.bodyExamples,
      });

      if (!created.ok && isAccessTokenError(created)) {
        // Igual que ensureRecallTemplatesSubmitted: la conexión está
        // muerta, no la plantilla — sin fila, y se deja de intentar con
        // ella este ciclo.
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
          'prospecting_templates.ensure_submit_failed',
          new Error(created.error),
          { connectionId: connection.id, template: def.name },
          'warn',
        );
      }
    }
  }

  return result;
}
