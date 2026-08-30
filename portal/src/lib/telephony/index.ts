import 'server-only';
import { twilioProvider, isTwilioConfigured } from './twilio';
import type { TelephonyProvider } from './types';

export type {
  TelephonyProvider,
  TelephonyResult,
  AvailableNumber,
  ProvisionedNumber,
  SearchNumbersOptions,
  ProvisionNumberOptions,
  SendSmsOptions,
  SentSms,
} from './types';

// =============================================================================
// WP-XX — telephony provider registry.
//
// One provider today. The indirection is here so the pool logic in
// recall-numbers.ts imports a contract rather than Twilio directly, which
// is what lets its tests inject the fake (see ./fake) without any module
// mocking gymnastics.
// =============================================================================

export function isTelephonyConfigured(): Promise<boolean> {
  return isTwilioConfigured();
}

export function getTelephonyProvider(): TelephonyProvider {
  return twilioProvider;
}
