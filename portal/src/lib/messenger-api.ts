import 'server-only';
import { graphUrl } from './meta-business';
import { logError } from './observability';

// =============================================================================
// Canales — activación real de Messenger. Mismo espíritu que
// whatsapp-api.ts/telegram-api.ts: fina capa fetch-directa, nunca lanza.
//
// A diferencia de WhatsApp (suscripción a nivel de WABA), Messenger se
// suscribe a nivel de PÁGINA — subscribePage(pageAccessToken, pageId),
// POST /{page-id}/subscribed_apps. Instagram Messaging comparte esa
// misma suscripción (una cuenta de Instagram profesional siempre está
// vinculada a una Página, y el campo de mensajería de Instagram se
// habilita en la MISMA app-webhook config, no en una suscripción
// aparte) — ver instagram-api.ts, que por eso no tiene su propio
// subscribe.
//
// UNVERIFIED AGAINST A REAL META APP — mismo aviso que meta-business.ts
// y whatsapp-api.ts.
// =============================================================================

export type MessengerApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function callGraphApi<T>(
  accessToken: string,
  path: string,
  method: 'POST' | 'DELETE',
  body?: Record<string, unknown>,
): Promise<MessengerApiResult<T>> {
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
      return { ok: false, error: message ?? `messenger_api_http_${res.status}` };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    logError('messenger_api.request_failed', err, { route: 'lib/messenger-api.ts', path, method }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export function subscribePage(pageAccessToken: string, pageId: string): Promise<MessengerApiResult<{ success: boolean }>> {
  return callGraphApi<{ success: boolean }>(pageAccessToken, `/${pageId}/subscribed_apps`, 'POST', {
    subscribed_fields: 'messages,messaging_postbacks',
  });
}

export function sendMessage(
  pageAccessToken: string,
  pageId: string,
  recipientPsid: string,
  text: string,
): Promise<MessengerApiResult<{ message_id?: string }>> {
  return callGraphApi<{ message_id?: string }>(pageAccessToken, `/${pageId}/messages`, 'POST', {
    recipient: { id: recipientPsid },
    message: { text },
  });
}
