// =============================================================================
// WP-XX — provider-agnostic telephony contract for the 'recall' product.
//
// Deliberately narrow: this is the whole surface the portal needs from a
// telephony provider for number management. Call handling is NOT here —
// that arrives as provider webhooks hitting our own routes (Fase 3), not
// as calls we make outwards.
//
// The interface exists so the Twilio implementation can be swapped or
// A/B'd without touching the pool logic, and so tests never talk to a
// real provider. There is no plan to run two providers at once; the
// abstraction is for testability and exit cost, not multi-homing.
//
// Same result-union convention as whatsapp-api.ts: these functions never
// throw, they return `{ ok: false, error }`. A provider outage must
// surface as a 502 the operator can retry, not a stack trace.
// =============================================================================

export type TelephonyResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface AvailableNumber {
  e164: string;
  /** ISO-3166-1 alpha-2, e.g. 'ES'. */
  countryCode: string;
  /** Provider-reported locality, when it reports one. Display only. */
  locality?: string | null;
}

export interface ProvisionedNumber {
  /** The provider's own identifier — Twilio's PN… SID. */
  providerSid: string;
  e164: string;
  countryCode: string;
}

export interface SearchNumbersOptions {
  countryCode: string;
  /** How many candidates to return. Providers cap this; treat as a hint. */
  limit?: number;
  /** Spanish area/prefix filter, e.g. '928' for Las Palmas. */
  areaCode?: string;
}

export interface ProvisionNumberOptions {
  e164: string;
  /**
   * Where the provider should POST when a call arrives. Set at
   * provision time so a number is never live without a handler — a
   * number that rings into nothing is worse than no number at all.
   * Fase 3 is what makes this URL do something useful.
   */
  voiceWebhookUrl?: string;
  /** Human label shown in the provider console. Ops convenience only. */
  friendlyName?: string;
}

export interface TelephonyProvider {
  readonly name: string;
  searchAvailableNumbers(opts: SearchNumbersOptions): Promise<TelephonyResult<AvailableNumber[]>>;
  provisionNumber(opts: ProvisionNumberOptions): Promise<TelephonyResult<ProvisionedNumber>>;
  /** Idempotent by contract: releasing an already-released SID must
   *  resolve ok, not error. Callers retry this after partial failures. */
  releaseNumber(providerSid: string): Promise<TelephonyResult<null>>;
}
