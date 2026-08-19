import 'server-only';
import { logError } from './observability';

// =============================================================================
// Canales — activación real de Telegram. Fina capa sobre la Bot API,
// mismo patrón fetch-directo-sin-SDK que google-business.ts. Nunca
// lanza — cada función devuelve un resultado tipado y deja que el
// caller decida qué hacer con un fallo (mismo espíritu que
// review-reply-ai.ts).
//
// setWebhook/deleteWebhook los llama el propio portal en el momento de
// conectar/desconectar (tiene el token en memoria ahí, antes de
// cifrarlo) — n8n nunca ve el token. sendMessage lo llama el portal por
// cuenta de n8n vía POST /api/internal/channels/telegram/send: es la
// ÚNICA vez que el token se descifra después del connect inicial, y
// nunca sale del servidor del portal.
// =============================================================================

const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

export type TelegramApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function callTelegramApi<T>(token: string, method: string, body: Record<string, unknown>): Promise<TelegramApiResult<T>> {
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!res.ok || !json?.ok) {
      return { ok: false, error: json?.description ?? `telegram_api_http_${res.status}` };
    }
    return { ok: true, data: json.result as T };
  } catch (err) {
    logError('telegram_api.request_failed', err, { route: 'lib/telegram-api.ts', method }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

export function setWebhook(token: string, webhookUrl: string): Promise<TelegramApiResult<true>> {
  return callTelegramApi<true>(token, 'setWebhook', { url: webhookUrl });
}

export function deleteWebhook(token: string): Promise<TelegramApiResult<true>> {
  return callTelegramApi<true>(token, 'deleteWebhook', {});
}

export function sendMessage(token: string, chatId: string | number, text: string): Promise<TelegramApiResult<{ message_id: number }>> {
  return callTelegramApi<{ message_id: number }>(token, 'sendMessage', { chat_id: chatId, text });
}
