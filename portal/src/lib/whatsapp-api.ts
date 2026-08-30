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
/**
 * Make a string safe to pass as a template parameter.
 *
 * Meta rejects the whole send with
 * "Param text cannot have new-line/tab characters or more than 4
 * consecutive spaces". That is not a soft warning — it is a hard 400,
 * and isRetryableWhatsAppError correctly refuses to retry it, so an
 * unsanitised newline means the message is simply never delivered.
 *
 * It bites hardest where you would least expect it: a transcript of a
 * recorded message, or a numbered digest, both naturally contain
 * newlines. Callers that build parameters from free text MUST run them
 * through this.
 */
export function sanitiseTemplateParam(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
}

export interface TemplateSpec {
  name: string;
  languageCode: string;
  bodyParams?: readonly string[];
  /**
   * Suffix for a template's dynamic URL button. The base URL is fixed in
   * the template Meta approved and only the tail varies, which is how a
   * per-recipient tracking link is sent without putting a raw URL in a
   * body parameter (Meta flags those, and they render as plain text
   * rather than a button).
   */
  buttonUrlSuffix?: string;
}

export function sendTemplate(
  accessToken: string,
  phoneNumberId: string,
  to: string,
  template: TemplateSpec,
): Promise<WhatsAppApiResult<{ messages?: Array<{ id: string }> }>> {
  const components: Array<Record<string, unknown>> = [];

  if (template.bodyParams && template.bodyParams.length > 0) {
    components.push({
      type: 'body',
      parameters: template.bodyParams.map((text) => ({
        type: 'text',
        text: sanitiseTemplateParam(text),
      })),
    });
  }

  if (template.buttonUrlSuffix !== undefined) {
    components.push({
      type: 'button',
      sub_type: 'url',
      // Button components are addressed by position, and this product's
      // templates carry exactly one button.
      index: '0',
      parameters: [{ type: 'text', text: sanitiseTemplateParam(template.buttonUrlSuffix) }],
    });
  }

  return callGraphApi<{ messages?: Array<{ id: string }> }>(accessToken, `/${phoneNumberId}/messages`, 'POST', {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.languageCode },
      // Omitted entirely when empty: Meta rejects an empty array.
      ...(components.length > 0 ? { components } : {}),
    },
  });
}

export interface WhatsAppPhoneNumberInfo {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  /** 'CLOUD_API' | 'ON_PREMISE' | 'NOT_APPLICABLE' — see
   *  MetaChannelConnection.platformType's schema comment. */
  platform_type?: string;
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
    `/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,platform_type`,
    'GET',
  );
}

export interface WhatsAppPhoneNumberSummary {
  id?: string;
  display_phone_number?: string;
}

/**
 * Fase 8 ('recall') — Coexistence. The FINISH_WHATSAPP_BUSINESS_APP_
 * ONBOARDING popup event carries only a `waba_id`, never a
 * `phone_number_id` — unlike the standard FINISH event, which returns
 * both. recall-meta.ts resolves the id itself from here. A WABA reached
 * through this onboarding path has exactly one number (the one already
 * live on the owner's phone), so the caller can safely take the first
 * result; a WABA with more would be a signal something unexpected
 * happened, worth surfacing rather than silently picking one.
 */
export function getPhoneNumbersForWaba(
  accessToken: string,
  wabaId: string,
): Promise<WhatsAppApiResult<{ data?: WhatsAppPhoneNumberSummary[] }>> {
  return callGraphApi<{ data?: WhatsAppPhoneNumberSummary[] }>(
    accessToken,
    `/${wabaId}/phone_numbers?fields=id,display_phone_number`,
    'GET',
  );
}

/**
 * Fase 8 ('recall') — Coexistence. Kicks off Meta's one-time sync of the
 * owner's existing contacts and message history from the WhatsApp
 * Business app into the Cloud API side of the connection. Best-effort by
 * every caller (same posture as subscribeWaba/getPhoneNumberInfo above):
 * the connection is already valid without it, and a sync that starts a
 * few minutes late is a support ticket, not a broken product.
 */
export function syncSmbAppState(
  accessToken: string,
  phoneNumberId: string,
): Promise<WhatsAppApiResult<{ success?: boolean }>> {
  return callGraphApi<{ success?: boolean }>(accessToken, `/${phoneNumberId}/smb_app_data`, 'POST', {
    messaging_product: 'whatsapp',
    sync_type: 'smb_app_state_sync',
  });
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

export interface CreateTemplateResult {
  id?: string;
  status?: string;
  category?: string;
}

/**
 * Submit one message template to a WABA for Meta's review.
 *
 * Every template this product uses has a single BODY component — none
 * carry a header, footer, or button (see sendTemplate's callers, all of
 * which pass bodyParams only). `bodyExamples` fills Meta's required
 * `example.body_text`: a template with {{n}} placeholders and no example
 * is rejected outright, since Meta's reviewer has nothing concrete to
 * check the placeholder against.
 *
 * The response's `status` is Meta's IMMEDIATE placement on submission —
 * almost always 'PENDING'. The real approved/rejected outcome only shows
 * up later and must be discovered by polling listMessageTemplates (see
 * whatsapp-health.ts's syncTemplateStatuses); this call never returns it.
 */
export function createMessageTemplate(
  accessToken: string,
  wabaId: string,
  spec: {
    name: string;
    languageCode: string;
    category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
    bodyText: string;
    bodyExamples?: readonly string[];
  },
): Promise<WhatsAppApiResult<CreateTemplateResult>> {
  return callGraphApi<CreateTemplateResult>(accessToken, `/${wabaId}/message_templates`, 'POST', {
    name: spec.name,
    language: spec.languageCode,
    category: spec.category,
    components: [
      {
        type: 'BODY',
        text: spec.bodyText,
        ...(spec.bodyExamples && spec.bodyExamples.length > 0
          ? { example: { body_text: [spec.bodyExamples] } }
          : {}),
      },
    ],
  });
}
