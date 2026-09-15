import 'server-only';
import webpush from 'web-push';
import type { PrismaClient } from '@prisma/client';
import { logError } from './observability';

// =============================================================================
// Fase 5d — enviar notificaciones push a los dispositivos de un cliente.
//
// POR QUÉ UNA LIBRERÍA AQUÍ, cuando el CSV se escribió a mano: Web Push
// exige cifrar cada mensaje con ECDH + HKDF + AES-128-GCM (RFC 8291) y
// firmar un JWT ES256 para VAPID. Un parser de CSV mal escrito mete datos
// raros; criptografía mal escrita manda mensajes que el navegador descarta
// en silencio, o peor, que parecen funcionar. Es exactamente donde se usa
// una librería probada y no una de cuarenta líneas.
//
// NUNCA LANZA, como el libro mayor y por lo mismo: una notificación es un
// aviso extra, no el producto. El recado al dueño ya salió por WhatsApp;
// si el push falla, nadie se queda sin enterarse, solo se entera por un
// canal. Propagar el error tumbaría el flujo que sí importa.
//
// SIN CLAVES VAPID, NO HACE NADA — degrada con gracia como el resto de
// integraciones, y `isPushConfigured()` deja que la interfaz no ofrezca
// activar algo que no puede funcionar.
//
// EL CONTENIDO VA CORTO Y SIN DATOS SENSIBLES. Una notificación se ve en
// la pantalla de bloqueo, delante de quien esté mirando el móvil. "Nueva
// llamada perdida" sí; la transcripción del recado, no — esa se lee
// dentro de la app, con la sesión abierta.
// =============================================================================

/** Payload máximo que aceptan todos los servicios push principales. Un
 *  mensaje por encima de 4KB se rechaza entero, no se trunca. */
const MAX_PAYLOAD_BYTES = 3_800;

export interface PushPayload {
  title: string;
  body: string;
  /** Adónde lleva tocar la notificación. Siempre dentro de /portal. */
  url: string;
  /** Agrupa notificaciones: una segunda del mismo tag sustituye a la
   *  primera en vez de apilarse. Cinco llamadas perdidas seguidas son un
   *  aviso actualizado, no cinco. */
  tag?: string;
}

export function isPushConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT,
  );
}

/** La clave pública la necesita el navegador para suscribirse. Es pública
 *  de verdad —va en el JavaScript del cliente— así que exponerla no es un
 *  descuido. */
export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

let configured = false;
function ensureVapid(): boolean {
  if (!isPushConfigured()) return false;
  if (!configured) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT!,
      process.env.VAPID_PUBLIC_KEY!,
      process.env.VAPID_PRIVATE_KEY!,
    );
    configured = true;
  }
  return true;
}

/**
 * Valida y serializa el payload.
 *
 * Pura y exportada para poder probarla sin red. Dos reglas:
 *  - la URL tiene que ser una ruta interna del portal: una notificación que
 *    abra un dominio ajeno es la forma de convertir un aviso en phishing;
 *  - el tamaño se comprueba antes de enviar, porque el servicio rechaza el
 *    mensaje entero y no avisa de por qué.
 */
export function serialisePayload(payload: PushPayload): string | null {
  if (!payload.url.startsWith('/portal')) return null;
  const json = JSON.stringify({
    title: payload.title.slice(0, 80),
    body: payload.body.slice(0, 180),
    url: payload.url,
    ...(payload.tag ? { tag: payload.tag.slice(0, 64) } : {}),
  });
  return Buffer.byteLength(json, 'utf8') <= MAX_PAYLOAD_BYTES ? json : null;
}

export interface PushSendResult {
  sent: number;
  failed: number;
  /** Suscripciones borradas porque el servicio dijo que ya no existen. */
  pruned: number;
  skipped?: 'not_configured' | 'invalid_payload' | 'no_subscriptions';
}

/** 404 y 410 son "esta suscripción ya no existe": desinstalación, permiso
 *  revocado o rotación del navegador. Cualquier otro error es transitorio
 *  y la fila se conserva. */
export function isGoneStatus(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410;
}

export async function sendPushToClient(
  prisma: PrismaClient,
  clientId: string,
  payload: PushPayload,
  deps: { send?: typeof webpush.sendNotification; now?: Date } = {},
): Promise<PushSendResult> {
  const empty: PushSendResult = { sent: 0, failed: 0, pruned: 0 };
  if (!deps.send && !ensureVapid()) return { ...empty, skipped: 'not_configured' };

  const body = serialisePayload(payload);
  if (!body) return { ...empty, skipped: 'invalid_payload' };

  const send = deps.send ?? webpush.sendNotification.bind(webpush);
  const now = deps.now ?? new Date();

  let subscriptions;
  try {
    subscriptions = await prisma.pushSubscription.findMany({
      where: { clientId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
  } catch (err) {
    logError('push.load_failed', err, { clientId }, 'warn');
    return { ...empty, failed: 1 };
  }
  if (subscriptions.length === 0) return { ...empty, skipped: 'no_subscriptions' };

  const result: PushSendResult = { ...empty };

  for (const sub of subscriptions) {
    try {
      await send(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        // TTL de una hora: un aviso de llamada perdida que llega al día
        // siguiente porque el móvil estaba apagado ya no es un aviso.
        { TTL: 3600, urgency: 'high' },
      );
      result.sent += 1;
      await prisma.pushSubscription
        .update({ where: { id: sub.id }, data: { lastSuccessAt: now } })
        .catch(() => null);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (isGoneStatus(statusCode)) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => null);
        result.pruned += 1;
      } else {
        result.failed += 1;
        logError('push.send_failed', err, { clientId, statusCode }, 'warn');
      }
    }
  }

  return result;
}
