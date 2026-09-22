import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { logError } from './observability';
import { safeFetch, BlockedUrlError } from './safe-fetch';

// =============================================================================
// Fase 4 — entrega de leads al CRM del cliente.
//
// El rastro y los reintentos se apoyan en ChannelWebhookDelivery, que ya
// existe y cuyo propio comentario dice que connectionType es libre porque
// «it's the same delivery+retry plumbing either way». Lo que NO se puede
// reutilizar es la entrega en sí: channel-webhook.ts manda siempre a la
// URL de n8n que hay en el entorno, y aquí el destino es distinto por
// cliente. Esa es la única diferencia real entre los dos caminos.
//
// **Se firma cada envío.** El cliente recibe una llamada a un endpoint
// suyo diciendo «tienes un lead nuevo, y estos son sus datos». Sin firma,
// cualquiera que averigüe esa URL puede meterle contactos falsos en el
// CRM. La cabecera es x-kairikos-signature: sha256=<hmac hex del cuerpo>.
// =============================================================================

export const SIGNATURE_HEADER = 'x-kairikos-signature';

/** Un fallo de entrega no puede retrasar la respuesta al que trajo el
 *  lead. Diez segundos es de sobra para un webhook y poco para colgarse. */
const DELIVERY_TIMEOUT_MS = 10_000;

/** Secreto de 32 bytes en hex. Se genera aquí y se le enseña al cliente
 *  una vez: nunca se le pide que invente uno, porque la mitad escribiría
 *  el nombre de su perro. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex');
}

/** La firma que viaja en la cabecera. Exportada porque es lo que el
 *  cliente tiene que reproducir en su extremo: si esta función y la
 *  documentación se separan, sus comprobaciones fallan todas y no hay
 *  forma de que lo averigüe por su cuenta. */
export function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/** Comparación en tiempo constante, para el día que exista una ruta que
 *  reciba webhooks firmados así. Misma postura que internal-auth.ts. */
export function verifySignature(body: string, secret: string, received: string): boolean {
  const expected = Buffer.from(signPayload(body, secret));
  const actual = Buffer.from(received);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface LeadWebhookPayload {
  event: 'lead.created';
  leadId: string;
  clientId: string;
  createdAt: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  source: string;
  channel: string | null;
  score: number | null;
  scoreReason: string | null;
  summary: string | null;
}

export interface LeadForWebhook {
  id: string;
  clientId: string;
  createdAt: Date;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  source: string;
  channel: string | null;
  score: number | null;
  scoreReason: string | null;
  summary: string | null;
}

/** Pura: el cuerpo exacto que recibe el CRM. Exportada para poder fijar en
 *  un test la forma que se le documentó al cliente — cambiarla en silencio
 *  rompe integraciones que no controlamos. */
export function buildLeadPayload(lead: LeadForWebhook): LeadWebhookPayload {
  return {
    event: 'lead.created',
    leadId: lead.id,
    clientId: lead.clientId,
    createdAt: lead.createdAt.toISOString(),
    contactName: lead.contactName,
    contactPhone: lead.contactPhone,
    contactEmail: lead.contactEmail,
    source: lead.source,
    channel: lead.channel,
    score: lead.score,
    scoreReason: lead.scoreReason,
    summary: lead.summary,
  };
}

export type DeliveryOutcome =
  | { ok: true }
  | { ok: false; error: string };

/** Un intento, nunca lanza. Igual que attemptDelivery en
 *  channel-webhook.ts, y por el mismo motivo: lo comparten el primer envío
 *  y todos los reintentos, así que la forma de la petición no puede
 *  divergir entre ellos. */
async function attempt(url: string, secret: string, body: string): Promise<DeliveryOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    // La URL del CRM la escribe el cliente, y el error devuelve 300 bytes de
    // la respuesta: safeFetch impide apuntarla a la red interna.
    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signPayload(body, secret),
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `webhook_error:${res.status}:${text.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof BlockedUrlError) return { ok: false, error: 'webhook_url_not_allowed' };
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: isAbort ? 'timeout' : err instanceof Error ? err.message : 'unknown_error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Entrega un lead al CRM del cliente, si lo tiene configurado.
 *
 * **Nunca lanza y nunca bloquea nada importante.** Lo llama el camino que
 * acaba de crear el lead: perder el lead porque el CRM del cliente está
 * caído sería el peor de los fallos posibles, así que el lead ya está
 * guardado antes de llegar aquí y esto solo añade un intento.
 *
 * Un fallo deja la fila de ChannelWebhookDelivery en 'failed', que es lo
 * que recoge el barrido de reintentos que ya existe — sin escribir una
 * segunda máquina de backoff.
 */
export async function deliverLeadToCrm(
  prisma: PrismaClient,
  lead: LeadForWebhook,
): Promise<{ delivered: boolean; reason?: 'not_configured' | 'disabled' | 'failed' }> {
  try {
    const hook = await prisma.leadWebhook.findUnique({ where: { clientId: lead.clientId } });
    if (!hook) return { delivered: false, reason: 'not_configured' };
    if (!hook.enabled) return { delivered: false, reason: 'disabled' };

    const payload = buildLeadPayload(lead);
    const body = JSON.stringify(payload);
    const result = await attempt(hook.url, hook.secret, body);

    await prisma.channelWebhookDelivery.create({
      data: {
        connectionType: 'lead_crm',
        connectionId: hook.id,
        clientId: lead.clientId,
        payload: payload as unknown as Prisma.InputJsonValue,
        status: result.ok ? 'delivered' : 'failed',
        attempts: 1,
        lastAttemptAt: new Date(),
        lastError: result.ok ? null : result.error,
      },
    });

    await prisma.leadWebhook.update({
      where: { id: hook.id },
      data: {
        lastDeliveryAt: new Date(),
        lastDeliveryError: result.ok ? null : result.error,
      },
    });

    return result.ok ? { delivered: true } : { delivered: false, reason: 'failed' };
  } catch (err) {
    logError('lead_webhook.deliver_failed', err, { clientId: lead.clientId }, 'warn');
    return { delivered: false, reason: 'failed' };
  }
}

/**
 * Reintenta una entrega fallida al CRM.
 *
 * Vive aquí y no en channel-webhook.ts porque el destino sale de
 * LeadWebhook y no del entorno; el barrido genérico delega en esto cuando
 * ve una fila con connectionType 'lead_crm'.
 */
export async function retryLeadCrmDelivery(
  prisma: PrismaClient,
  deliveryId: string,
): Promise<DeliveryOutcome> {
  const delivery = await prisma.channelWebhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery || delivery.connectionType !== 'lead_crm') {
    return { ok: false, error: 'delivery_not_found' };
  }

  const hook = await prisma.leadWebhook.findUnique({ where: { id: delivery.connectionId } });
  if (!hook || !hook.enabled) {
    // El cliente ha quitado o apagado su webhook desde que falló. Se marca
    // entregada para que deje de reintentarse: ya no hay a dónde.
    await prisma.channelWebhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'delivered', lastError: 'webhook_removed' },
    });
    return { ok: false, error: 'webhook_removed' };
  }

  const body = JSON.stringify(delivery.payload);
  const result = await attempt(hook.url, hook.secret, body);

  await prisma.channelWebhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status: result.ok ? 'delivered' : 'failed',
      attempts: delivery.attempts + 1,
      lastAttemptAt: new Date(),
      lastError: result.ok ? null : result.error,
    },
  });

  return result;
}
