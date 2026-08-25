import 'server-only';
import { logError } from '../observability';
import type {
  AvailableNumber,
  ProvisionNumberOptions,
  ProvisionedNumber,
  SearchNumbersOptions,
  SendSmsOptions,
  SentSms,
  TelephonyProvider,
  TelephonyResult,
} from './types';

// =============================================================================
// WP-XX — Twilio implementation of TelephonyProvider.
//
// fetch-direct, no SDK — same convention as meta-business.ts and
// google-business.ts. Twilio's REST API is form-encoded and Basic-authed;
// pulling in the SDK for three endpoints would add a dependency whose
// main value (TwiML builders, helper types) we don't need here.
//
// Spanish numbering has a regulatory requirement: Twilio will reject
// provisioning without a Bundle (and usually an Address) proving who the
// service provider is. That registration is done ONCE, by us, in the
// Twilio console — never per client. TWILIO_BUNDLE_SID/TWILIO_ADDRESS_SID
// carry those ids into the provisioning call.
//
// UNVERIFIED AGAINST A REAL TWILIO ACCOUNT at the time of writing — the
// endpoint shapes follow Twilio's documented, long-stable 2010-04-01 API,
// but the first real provisioning call is the actual test this code
// hasn't had. Same caveat meta-business.ts carries, and for the same
// reason: no credentials reachable from this environment.
// =============================================================================

const API_BASE = 'https://api.twilio.com/2010-04-01';

export function isTwilioConfigured(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

function getCredentials(): { accountSid: string; authToken: string } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not configured');
  }
  return { accountSid, authToken };
}

function authHeader(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

interface TwilioErrorBody {
  message?: string;
  code?: number;
}

/**
 * One request helper for all three endpoints. Never throws: every failure
 * — network, non-2xx, unparseable body — comes back as
 * `{ ok: false, error }`.
 *
 * Twilio's error `code` is preserved in the message because the numeric
 * code is what distinguishes "you can retry this" from "this will never
 * work": 21422 (number unavailable) means pick another candidate, while
 * 21649 (bundle required) means stop and fix the regulatory registration.
 */
async function twilioRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  form?: Record<string, string>,
): Promise<TelephonyResult<T>> {
  let accountSid: string;
  let authToken: string;
  try {
    ({ accountSid, authToken } = getCredentials());
  } catch {
    return { ok: false, error: 'twilio_not_configured' };
  }

  const url = `${API_BASE}/Accounts/${accountSid}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: authHeader(accountSid, authToken),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });

    // DELETE returns 204 with an empty body on success.
    if (res.status === 204) {
      return { ok: true, data: null as T };
    }

    const json = (await res.json().catch(() => null)) as (T & TwilioErrorBody) | null;
    if (!res.ok) {
      const body = json as TwilioErrorBody | null;
      const detail = body?.message ?? `http_${res.status}`;
      return { ok: false, error: body?.code ? `${body.code}: ${detail}` : detail };
    }
    return { ok: true, data: json as T };
  } catch (err) {
    logError('telephony.twilio.request_failed', err, { path, method }, 'warn');
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

interface TwilioAvailableNumbersResponse {
  available_phone_numbers?: Array<{
    phone_number?: string;
    iso_country?: string;
    locality?: string | null;
  }>;
}

interface TwilioMessageResponse {
  sid?: string;
}

interface TwilioIncomingNumberResponse {
  sid?: string;
  phone_number?: string;
  iso_country?: string;
}

export const twilioProvider: TelephonyProvider = {
  name: 'twilio',

  async searchAvailableNumbers(opts: SearchNumbersOptions): Promise<TelephonyResult<AvailableNumber[]>> {
    const params = new URLSearchParams();
    if (opts.limit) params.set('PageSize', String(opts.limit));
    if (opts.areaCode) params.set('AreaCode', opts.areaCode);
    const query = params.toString() ? `?${params.toString()}` : '';

    const result = await twilioRequest<TwilioAvailableNumbersResponse>(
      'GET',
      `/AvailablePhoneNumbers/${encodeURIComponent(opts.countryCode)}/Local.json${query}`,
    );
    if (!result.ok) return result;

    const numbers = (result.data.available_phone_numbers ?? [])
      .filter((n): n is { phone_number: string; iso_country?: string; locality?: string | null } =>
        typeof n.phone_number === 'string',
      )
      .map((n) => ({
        e164: n.phone_number,
        countryCode: n.iso_country ?? opts.countryCode,
        locality: n.locality ?? null,
      }));
    return { ok: true, data: numbers };
  },

  async provisionNumber(opts: ProvisionNumberOptions): Promise<TelephonyResult<ProvisionedNumber>> {
    const form: Record<string, string> = { PhoneNumber: opts.e164 };
    if (opts.voiceWebhookUrl) {
      form.VoiceUrl = opts.voiceWebhookUrl;
      form.VoiceMethod = 'POST';
    }
    if (opts.friendlyName) form.FriendlyName = opts.friendlyName;
    // Spanish (and most EU) numbering: Twilio rejects the purchase without
    // the service provider's regulatory bundle. Registered once by us, not
    // per client — see this module's header.
    if (process.env.TWILIO_BUNDLE_SID) form.BundleSid = process.env.TWILIO_BUNDLE_SID;
    if (process.env.TWILIO_ADDRESS_SID) form.AddressSid = process.env.TWILIO_ADDRESS_SID;

    const result = await twilioRequest<TwilioIncomingNumberResponse>('POST', '/IncomingPhoneNumbers.json', form);
    if (!result.ok) return result;

    const { sid, phone_number: phoneNumber, iso_country: isoCountry } = result.data;
    if (!sid || !phoneNumber) {
      return { ok: false, error: 'twilio_response_missing_sid_or_number' };
    }
    return {
      ok: true,
      data: { providerSid: sid, e164: phoneNumber, countryCode: isoCountry ?? 'ES' },
    };
  },

  async releaseNumber(providerSid: string): Promise<TelephonyResult<null>> {
    const result = await twilioRequest<null>('DELETE', `/IncomingPhoneNumbers/${encodeURIComponent(providerSid)}.json`);
    if (result.ok) return { ok: true, data: null };
    // Releasing something already gone is success, not failure — the
    // contract in types.ts promises idempotency because callers retry
    // this after partial failures. Twilio answers 404 for an unknown SID.
    if (result.error.startsWith('20404') || result.error === 'http_404') {
      return { ok: true, data: null };
    }
    return result;
  },

  async sendSms(opts: SendSmsOptions): Promise<TelephonyResult<SentSms>> {
    const result = await twilioRequest<TwilioMessageResponse>('POST', '/Messages.json', {
      To: opts.to,
      From: opts.from,
      Body: opts.body,
    });
    if (!result.ok) return result;
    if (!result.data.sid) return { ok: false, error: 'twilio_response_missing_message_sid' };
    return { ok: true, data: { providerSid: result.data.sid } };
  },
};
