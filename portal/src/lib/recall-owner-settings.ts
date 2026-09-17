import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { normaliseE164 } from './recall-blocklist';
import { looksLikeWhatsAppCapable } from './recall-messaging';
import { sendForwardingInstructions, type ForwardingInstructionsOutcome } from './recall-templates';
import { sniffAudio } from './wav-audio';
import { logError } from './observability';

// =============================================================================
// 2026-09-16 — los dos datos de un alta de recall que NADA permitía guardar.
//
// `ownerWhatsapp` es a donde van los recados, el resumen de las 19:00, el
// informe mensual y los códigos de desvío. `greetingAudio` es la locución
// que oye quien llama. Las dos columnas existían desde la fase 1, el código
// las leía en una docena de sitios, y no había ni una ruta ni una pantalla
// que las escribiera. El único cliente en producción se quedó en
// forwarding_pending por eso: los códigos de desvío se "enviaron" a un
// número vacío y el envío se saltó sin más.
//
// Las usan dos superficies con la misma regla: el portal del cliente
// (/portal/llamadas) y la ficha del operador, que es quien lo rellena
// cuando el alta se hace por teléfono — el producto no puede EXIGIR que el
// dueño entre al portal (ver recall-product-decisions).
// =============================================================================

export const MAX_GREETING_BYTES = 1_000_000;
export const MIN_GREETING_SECONDS = 2;
export const MAX_GREETING_SECONDS = 30;

export type RecallSettingsActor =
  | { type: 'client'; clientId: string }
  | { type: 'operator'; operatorId: string; email: string | null };

function auditActor(actor: RecallSettingsActor) {
  return actor.type === 'client'
    ? { actorType: 'client', actorOperatorId: null, actorEmail: `client:${actor.clientId}` }
    : { actorType: 'operator', actorOperatorId: actor.operatorId, actorEmail: actor.email };
}

/** Solo los cuatro últimos: la auditoría dice que cambió, no a quién. */
function maskNumber(e164: string | null): string | null {
  return e164 ? `…${e164.slice(-4)}` : null;
}

export interface RecallOwnerSettingsView {
  subscriptionId: string;
  status: string;
  ownerWhatsapp: string | null;
  /** El número de WhatsApp del negocio, si ya está conectado. */
  businessNumber: string | null;
  virtualNumber: string | null;
  greeting: { mimeType: string; sizeBytes: number; recordedAt: string | null } | null;
}

export async function loadRecallOwnerSettings(
  prisma: PrismaClient,
  where: { clientId: string } | { subscriptionId: string },
): Promise<RecallOwnerSettingsView | null> {
  const sub = await prisma.recallSubscription.findFirst({
    where: 'clientId' in where ? { clientId: where.clientId } : { id: where.subscriptionId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      ownerWhatsapp: true,
      greetingAudio: true,
      greetingMimeType: true,
      greetingRecordedAt: true,
      virtualNumber: { select: { e164: true } },
      metaConnection: { select: { displayPhoneNumber: true } },
    },
  });
  if (!sub) return null;
  return {
    subscriptionId: sub.id,
    status: sub.status,
    ownerWhatsapp: sub.ownerWhatsapp,
    businessNumber: sub.metaConnection?.displayPhoneNumber ?? null,
    virtualNumber: sub.virtualNumber?.e164 ?? null,
    greeting: sub.greetingAudio
      ? {
          mimeType: sub.greetingMimeType ?? 'audio/mpeg',
          sizeBytes: sub.greetingAudio.length,
          recordedAt: sub.greetingRecordedAt?.toISOString() ?? null,
        }
      : null,
  };
}

// -----------------------------------------------------------------------------
// WhatsApp del dueño
// -----------------------------------------------------------------------------

export type OwnerWhatsappValidation =
  | { ok: true; e164: string }
  | { ok: false; error: 'invalid_number' | 'not_mobile' | 'same_as_business' };

/**
 * Pura. Tres reglas, cada una por un fallo que no daría error:
 *   · un fijo español no tiene WhatsApp: los recados no llegarían nunca;
 *   · el número del negocio no vale: con Coexistence, el negocio ESCRIBE
 *     desde ese número, y WhatsApp no entrega un mensaje a uno mismo.
 */
export function validateOwnerWhatsapp(raw: string, businessNumber: string | null): OwnerWhatsappValidation {
  const e164 = normaliseE164(raw);
  if (!e164 || e164.length > 16) return { ok: false, error: 'invalid_number' };
  if (!looksLikeWhatsAppCapable(e164)) return { ok: false, error: 'not_mobile' };
  const business = businessNumber ? normaliseE164(businessNumber) : null;
  if (business && business === e164) return { ok: false, error: 'same_as_business' };
  return { ok: true, e164 };
}

export type SetOwnerWhatsappResult =
  | { ok: true; ownerWhatsapp: string; forwardingInstructions: ForwardingInstructionsOutcome | null }
  | { ok: false; error: 'not_found' | Extract<OwnerWhatsappValidation, { ok: false }>['error'] };

export async function setOwnerWhatsapp(
  prisma: PrismaClient,
  input: { subscriptionId: string; raw: string; actor: RecallSettingsActor },
): Promise<SetOwnerWhatsappResult> {
  const sub = await prisma.recallSubscription.findUnique({
    where: { id: input.subscriptionId },
    select: {
      id: true,
      clientId: true,
      status: true,
      ownerWhatsapp: true,
      virtualNumber: { select: { e164: true } },
      metaConnection: {
        select: {
          id: true,
          externalId: true,
          status: true,
          displayPhoneNumber: true,
          accessTokenCiphertext: true,
          accessTokenIv: true,
          accessTokenTag: true,
        },
      },
    },
  });
  if (!sub) return { ok: false, error: 'not_found' };
  // Un cliente solo toca su propia suscripción. La ruta ya lo garantiza al
  // resolverla por sesión; esto es la segunda cerradura.
  if (input.actor.type === 'client' && sub.clientId !== input.actor.clientId) return { ok: false, error: 'not_found' };

  const valid = validateOwnerWhatsapp(input.raw, sub.metaConnection?.displayPhoneNumber ?? null);
  if (!valid.ok) return valid;

  await prisma.recallSubscription.update({ where: { id: sub.id }, data: { ownerWhatsapp: valid.e164 } });
  await prisma.recallSubscriptionAudit
    .create({
      data: {
        subscriptionId: sub.id,
        clientId: sub.clientId,
        action: 'owner_whatsapp_changed',
        before: { ownerWhatsapp: maskNumber(sub.ownerWhatsapp) },
        after: { ownerWhatsapp: maskNumber(valid.e164) },
        ...auditActor(input.actor),
      },
    })
    .catch((err) => logError('recall_owner_settings.audit_failed', err, { subscriptionId: sub.id }, 'warn'));

  // Los códigos de desvío solo se mandaban al pasar a forwarding_pending.
  // Si el alta ya está ahí, este es el momento de mandarlos: es el paso que
  // la tenía parada.
  //
  // 2026-09-17 — también con el MISMO número. Antes solo se reenviaban si el
  // número cambiaba, y el único cliente de producción se quedó sin ellos: lo
  // guardó cuando su WhatsApp estaba caído (el envío se saltó) y, al volver a
  // guardarlo con la conexión ya arreglada, el número era igual. Guardar con
  // el alta esperando el desvío es pedirlos; el coste es un mensaje.
  let forwardingInstructions: ForwardingInstructionsOutcome | null = null;
  if (sub.status === 'forwarding_pending') {
    forwardingInstructions = await sendForwardingInstructions({
      id: sub.id,
      ownerWhatsapp: valid.e164,
      virtualNumber: sub.virtualNumber,
      metaConnection: sub.metaConnection,
    });
  }

  return { ok: true, ownerWhatsapp: valid.e164, forwardingInstructions };
}

// -----------------------------------------------------------------------------
// Locución
// -----------------------------------------------------------------------------

export type GreetingValidation =
  | { ok: true; mimeType: 'audio/wav' | 'audio/mpeg'; durationSeconds: number | null }
  | { ok: false; error: 'too_large' | 'unsupported_format' | 'corrupt_wav' | 'too_short' | 'too_long' | 'empty' };

export function validateGreeting(bytes: Uint8Array): GreetingValidation {
  if (bytes.length === 0) return { ok: false, error: 'empty' };
  if (bytes.length > MAX_GREETING_BYTES) return { ok: false, error: 'too_large' };
  const sniffed = sniffAudio(bytes);
  if (!sniffed.ok) return sniffed;
  if (sniffed.durationSeconds !== null) {
    if (sniffed.durationSeconds < MIN_GREETING_SECONDS) return { ok: false, error: 'too_short' };
    if (sniffed.durationSeconds > MAX_GREETING_SECONDS + 0.5) return { ok: false, error: 'too_long' };
  }
  return { ok: true, mimeType: sniffed.mimeType, durationSeconds: sniffed.durationSeconds };
}

export type SetGreetingResult =
  | { ok: true; mimeType: string; durationSeconds: number | null; sizeBytes: number }
  | { ok: false; error: 'not_found' | Extract<GreetingValidation, { ok: false }>['error'] };

async function findOwned(prisma: PrismaClient, subscriptionId: string, actor: RecallSettingsActor) {
  const sub = await prisma.recallSubscription.findUnique({
    where: { id: subscriptionId },
    select: { id: true, clientId: true, greetingAudio: true, greetingMimeType: true },
  });
  if (!sub) return null;
  if (actor.type === 'client' && sub.clientId !== actor.clientId) return null;
  return sub;
}

export async function setGreeting(
  prisma: PrismaClient,
  input: { subscriptionId: string; bytes: Uint8Array; actor: RecallSettingsActor; now?: Date },
): Promise<SetGreetingResult> {
  const valid = validateGreeting(input.bytes);
  if (!valid.ok) return valid;
  const sub = await findOwned(prisma, input.subscriptionId, input.actor);
  if (!sub) return { ok: false, error: 'not_found' };

  const now = input.now ?? new Date();
  await prisma.recallSubscription.update({
    where: { id: sub.id },
    data: { greetingAudio: Buffer.from(input.bytes), greetingMimeType: valid.mimeType, greetingRecordedAt: now },
  });
  await prisma.recallSubscriptionAudit
    .create({
      data: {
        subscriptionId: sub.id,
        clientId: sub.clientId,
        action: 'greeting_recorded',
        before: { hadGreeting: sub.greetingAudio !== null },
        // Metadatos, nunca el audio: es la voz del dueño.
        after: { mimeType: valid.mimeType, sizeBytes: input.bytes.length, durationSeconds: valid.durationSeconds },
        ...auditActor(input.actor),
      },
    })
    .catch((err) => logError('recall_owner_settings.audit_failed', err, { subscriptionId: sub.id }, 'warn'));

  return { ok: true, mimeType: valid.mimeType, durationSeconds: valid.durationSeconds, sizeBytes: input.bytes.length };
}

export async function clearGreeting(
  prisma: PrismaClient,
  input: { subscriptionId: string; actor: RecallSettingsActor },
): Promise<{ ok: true } | { ok: false; error: 'not_found' }> {
  const sub = await findOwned(prisma, input.subscriptionId, input.actor);
  if (!sub) return { ok: false, error: 'not_found' };
  if (sub.greetingAudio === null) return { ok: true };

  await prisma.recallSubscription.update({
    where: { id: sub.id },
    data: { greetingAudio: null, greetingMimeType: null, greetingRecordedAt: null },
  });
  await prisma.recallSubscriptionAudit
    .create({
      data: {
        subscriptionId: sub.id,
        clientId: sub.clientId,
        action: 'greeting_removed',
        before: { hadGreeting: true },
        after: { hadGreeting: false },
        ...auditActor(input.actor),
      },
    })
    .catch((err) => logError('recall_owner_settings.audit_failed', err, { subscriptionId: sub.id }, 'warn'));
  return { ok: true };
}

/** El audio para escucharlo desde el portal — no la ruta pública de Twilio,
 *  que solo sirve suscripciones activas. */
export async function readGreeting(
  prisma: PrismaClient,
  input: { subscriptionId: string; actor: RecallSettingsActor },
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const sub = await findOwned(prisma, input.subscriptionId, input.actor);
  if (!sub?.greetingAudio) return null;
  return { bytes: new Uint8Array(sub.greetingAudio), mimeType: sub.greetingMimeType ?? 'audio/mpeg' };
}
