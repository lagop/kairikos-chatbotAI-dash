import 'server-only';
import { graphUrl } from './meta-business';
import { logError } from './observability';

// =============================================================================
// Canales — activación real de WhatsApp (Cloud API). Mismo espíritu que
// telegram-api.ts: fina capa fetch-directa, nunca lanza. La diferencia
// de forma frente a Telegram es real, no cosmética:
//
//   - Telegram: cada bot registra su PROPIA webhook URL (setWebhook).
//   - WhatsApp: hay UNA sola webhook URL a nivel de app (configurada una
//     vez en el Meta App Dashboard, fuera de este repo — no hay
//     endpoint de Graph API para eso). Lo que SÍ se hace por-cliente es
//     suscribir esa WABA a la app ya configurada
//     (subscribeWaba/unsubscribeWaba, POST/DELETE
//     /{waba-id}/subscribed_apps) — sin esta llamada, Meta nunca manda
//     los mensajes de esa cuenta a la webhook de la app, aunque la
//     webhook ya esté configurada.
//
// Igual que Telegram: el access token nunca sale del portal después del
// connect — sendMessage lo llama el portal por cuenta de n8n vía
// POST /api/internal/channels/whatsapp/send.
//
// UNVERIFIED AGAINST A REAL META APP — mismo aviso que meta-business.ts.
// =============================================================================

export type WhatsAppApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function callGraphApi<T>(
  accessToken: string,
  path: string,
  method: 'POST' | 'DELETE',
  body?: Record<string, unknown>,
): Promise<WhatsAppApiResult<T>> {
  try {
    const url = new URL(graphUrl(path));
    url.searchParams.set('access_token', accessToken);
    const res = await fetch(url.toString(), {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | (T & { success?: boolean }) | null;
    if (!res.ok || (json && typeof json === 'object' && 'error' in json && json.error)) {
      const message = json && typeof json === 'object' && 'error' in json ? json.error?.message : undefined;
      return { ok: false, error: message ?? `whatsapp_api_http_${res.status}` };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    logError('whatsapp_api.request_failed', err, { route: 'lib/whatsapp-api.ts', path, method }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export function subscribeWaba(accessToken: string, wabaId: string): Promise<WhatsAppApiResult<{ success: boolean }>> {
  return callGraphApi<{ success: boolean }>(accessToken, `/${wabaId}/subscribed_apps`, 'POST');
}

export function unsubscribeWaba(accessToken: string, wabaId: string): Promise<WhatsAppApiResult<{ success: boolean }>> {
  return callGraphApi<{ success: boolean }>(accessToken, `/${wabaId}/subscribed_apps`, 'DELETE');
}

export function sendMessage(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  text: string,
): Promise<WhatsAppApiResult<{ messages?: Array<{ id: string }> }>> {
  return callGraphApi<{ messages?: Array<{ id: string }> }>(accessToken, `/${phoneNumberId}/messages`, 'POST', {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  });
}
