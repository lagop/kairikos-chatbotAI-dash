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

// WP-XX — the failure shape now carries Meta's own numeric code, not just
// its prose. The code is what tells a caller whether to retry, give up,
// or escalate, and the message alone cannot: "message failed to send"
// covers both a transient outage and a permanently-paused template.
//
// The ones that drive real decisions:
//   131047  re-engagement required — the 24h service window has closed,
//           so this must go as a TEMPLATE, not free text.
//   131026  undeliverable — the number has no WhatsApp. Fall back to SMS.
//   132000  template parameter count mismatch — a bug in our own call;
//           retrying identically will fail identically.
//   132015  template paused by Meta for poor quality — stop sending it
//           and tell an operator, do not retry.
//   131056  pair rate limit — back off, retry later.
export type WhatsAppApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: number; subcode?: number; status?: number };

/** Meta error codes this codebase branches on. Exported so callers name
 *  the condition rather than sprinkling magic numbers. */
export const WHATSAPP_ERROR = {
  REENGAGEMENT_REQUIRED: 131047,
  UNDELIVERABLE: 131026,
  PAIR_RATE_LIMIT: 131056,
  TEMPLATE_PARAM_MISMATCH: 132000,
  TEMPLATE_PAUSED: 132015,
} as const;

/** Whether trying the identical request again could plausibly succeed. A
 *  parameter mismatch or a paused template never will; a rate limit or a
 *  5xx might. */
export function isRetryableWhatsAppError(result: { code?: number; status?: number }): boolean {
  if (result.code === WHATSAPP_ERROR.TEMPLATE_PARAM_MISMATCH) return false;
  if (result.code === WHATSAPP_ERROR.TEMPLATE_PAUSED) return false;
  if (result.code === WHATSAPP_ERROR.UNDELIVERABLE) return false;
  if (result.code === WHATSAPP_ERROR.PAIR_RATE_LIMIT) return true;
  if (result.status !== undefined && result.status >= 500) return true;
  if (result.status === 429) return true;
  return result.status === undefined;
}

interface GraphErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number };
}

async function callGraphApi<T>(
  accessToken: string,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
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
    const json = (await res.json().catch(() => null)) as (GraphErrorBody & T) | null;
    const graphError = json && typeof json === 'object' && 'error' in json ? json.error : undefined;
    if (!res.ok || graphError) {
      return {
        ok: false,
        error: graphError?.message ?? `whatsapp_api_http_${res.status}`,
        code: graphError?.code,
        subcode: graphError?.error_subcode,
        status: res.status,
      };
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

/**
 * Send an approved template.
 *
 * This — not sendMessage — is what the 'recall' product uses to reach a
 * caller. Free text only works inside WhatsApp's 24-hour customer service
 * window, which opens when the CUSTOMER messages the business. Someone
 * who rang and hung up never opened one, so every first message this
 * product sends is business-initiated outside the window and must be a
 * template. Using sendMessage there returns 131047 every time.
 *
 * `bodyParams` fills the template's {{1}}, {{2}}… placeholders in order.
 * The count must match what Meta approved or the send fails with 132000,
 * which is a bug in the caller rather than a transient error — see
 * isRetryableWhatsAppError.
 */
export function sendTemplate(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  template: { name: string; languageCode: string; bodyParams?: readonly string[] },
): Promise<WhatsAppApiResult<{ messages?: Array<{ id: string }> }>> {
  const components =
    template.bodyParams && template.bodyParams.length > 0
      ? [
          {
            type: 'body',
            parameters: template.bodyParams.map((text) => ({ type: 'text', text })),
          },
        ]
      : undefined;

  return callGraphApi<{ messages?: Array<{ id: string }> }>(accessToken, `/${phoneNumberId}/messages`, 'POST', {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.languageCode },
      ...(components ? { components } : {}),
    },
  });
}

export interface WhatsAppPhoneNumberInfo {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
}

/**
 * The business's REAL phone number, in E.164, plus how Meta currently
 * rates the number's quality.
 *
 * Until now the portal only ever stored `phone_number_id` and a label of
 * `WhatsApp (<wabaId>)` — it never knew what number a client actually
 * sends from, which makes support conversations ("which number is this?")
 * unanswerable. `quality_rating` matters for a different reason: Meta
 * degrades and eventually blocks numbers whose recipients report them,
 * and losing that number costs the client their working WhatsApp.
 */
export function getPhoneNumberInfo(
  accessToken: string,
  phoneNumberId: string,
): Promise<WhatsAppApiResult<WhatsAppPhoneNumberInfo>> {
  return callGraphApi<WhatsAppPhoneNumberInfo>(
    accessToken,
    `/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`,
    'GET',
  );
}

export interface WhatsAppTemplateSummary {
  id?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  rejected_reason?: string;
}

/**
 * List the templates registered on a WABA, with their review status.
 *
 * With Coexistence each client has their own WABA, so templates are
 * per-client and every new client needs their own set approved by Meta
 * before the product can send anything. That review sits in the critical
 * path of every alta, which is exactly why its status is worth polling
 * and surfacing rather than discovering by a failed send.
 */
export function listMessageTemplates(
  accessToken: string,
  wabaId: string,
  opts: { limit?: number } = {},
): Promise<WhatsAppApiResult<{ data?: WhatsAppTemplateSummary[] }>> {
  const limit = opts.limit ?? 100;
  return callGraphApi<{ data?: WhatsAppTemplateSummary[] }>(
    accessToken,
    `/${wabaId}/message_templates?fields=id,name,language,status,category,rejected_reason&limit=${limit}`,
    'GET',
  );
}
