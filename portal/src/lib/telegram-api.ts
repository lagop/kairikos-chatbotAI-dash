import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
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

// =============================================================================
// Revisión de seguridad del 22/09/2026 — el webhook de Telegram solo lo
// protegía el connectionId de la URL. Quien lo conociera (sale en los logs
// de n8n, en el historial de ejecuciones) podía mandar actualizaciones
// falsas: meter mensajes en una conversación ajena y gastar crédito de IA.
//
// Telegram firma cada entrega con la cabecera X-Telegram-Bot-Api-Secret-Token
// si al registrar el webhook se le da un `secret_token`. n8n la reenvía como
// `webhookSecret` a /api/internal/channels/telegram/reply, que la compara.
//
// El secreto se DERIVA del token del bot en vez de guardarse: quien tiene el
// token ya controla el bot entero (puede llamar él mismo a setWebhook), así
// que derivarlo de ahí no expone nada nuevo, no necesita migración ni una
// clave de cifrado más, y cambia solo cuando cambia el token. El prefijo
// separa este uso de cualquier otro hash del mismo token.
// Formato: Telegram admite 1-256 caracteres de [A-Za-z0-9_-]; hex cumple.
// =============================================================================

export function telegramWebhookSecret(botToken: string): string {
  return createHash('sha256').update(`kairikos-telegram-webhook-secret:${botToken}`).digest('hex');
}

/** Comparación en tiempo constante del secreto que reenvía n8n. */
export function telegramWebhookSecretMatches(botToken: string, provided: string | null | undefined): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expected = Buffer.from(telegramWebhookSecret(botToken));
  const given = Buffer.from(provided);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function setWebhook(token: string, webhookUrl: string): Promise<TelegramApiResult<true>> {
  return callTelegramApi<true>(token, 'setWebhook', {
    url: webhookUrl,
    secret_token: telegramWebhookSecret(token),
  });
}

export function deleteWebhook(token: string): Promise<TelegramApiResult<true>> {
  return callTelegramApi<true>(token, 'deleteWebhook', {});
}

export function sendMessage(token: string, chatId: string | number, text: string): Promise<TelegramApiResult<{ message_id: number }>> {
  return callTelegramApi<{ message_id: number }>(token, 'sendMessage', { chat_id: chatId, text });
}
