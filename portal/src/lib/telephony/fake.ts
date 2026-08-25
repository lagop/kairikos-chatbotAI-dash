import type {
  AvailableNumber,
  ProvisionNumberOptions,
  ProvisionedNumber,
  SearchNumbersOptions,
  TelephonyProvider,
  TelephonyResult,
} from './types';

// =============================================================================
// WP-XX — in-memory TelephonyProvider for tests.
//
// Deliberately NOT `server-only`: this is the double the unit tests and
// any future local/dev mode use, and it must import cleanly anywhere.
//
// It is a real implementation of the contract, not a stub that returns
// canned success: it keeps state, so a test can provision a number and
// then release it and observe that the second release is a no-op — which
// is the idempotency promise types.ts makes and the one thing most likely
// to be got wrong in the real provider.
// =============================================================================

export interface FakeTelephonyProvider extends TelephonyProvider {
  /** Numbers currently provisioned, keyed by providerSid. */
  readonly provisioned: Map<string, ProvisionedNumber>;
  /** Queue a failure for the next call to the named method. */
  failNext(method: 'search' | 'provision' | 'release', error: string): void;
  reset(): void;
}

export function createFakeTelephonyProvider(
  availablePool: readonly string[] = ['+34910000001', '+34910000002', '+34910000003'],
): FakeTelephonyProvider {
  const provisioned = new Map<string, ProvisionedNumber>();
  let available = [...availablePool];
  let sidCounter = 0;
  const failures: Partial<Record<'search' | 'provision' | 'release', string>> = {};

  function takeFailure(method: 'search' | 'provision' | 'release'): string | null {
    const error = failures[method];
    if (error === undefined) return null;
    delete failures[method];
    return error;
  }

  return {
    name: 'fake',
    provisioned,

    failNext(method, error) {
      failures[method] = error;
    },

    reset() {
      provisioned.clear();
      available = [...availablePool];
      sidCounter = 0;
      for (const key of Object.keys(failures)) {
        delete failures[key as keyof typeof failures];
      }
    },

    async searchAvailableNumbers(opts: SearchNumbersOptions): Promise<TelephonyResult<AvailableNumber[]>> {
      const failure = takeFailure('search');
      if (failure) return { ok: false, error: failure };
      const limit = opts.limit ?? available.length;
      return {
        ok: true,
        data: available.slice(0, limit).map((e164) => ({
          e164,
          countryCode: opts.countryCode,
          locality: null,
        })),
      };
    },

    async provisionNumber(opts: ProvisionNumberOptions): Promise<TelephonyResult<ProvisionedNumber>> {
      const failure = takeFailure('provision');
      if (failure) return { ok: false, error: failure };
      if (!available.includes(opts.e164)) {
        // Mirrors Twilio 21422: the number was taken between search and buy.
        return { ok: false, error: '21422: number is not available' };
      }
      available = available.filter((n) => n !== opts.e164);
      sidCounter += 1;
      const record: ProvisionedNumber = {
        providerSid: `PNfake${String(sidCounter).padStart(4, '0')}`,
        e164: opts.e164,
        countryCode: 'ES',
      };
      provisioned.set(record.providerSid, record);
      return { ok: true, data: record };
    },

    async releaseNumber(providerSid: string): Promise<TelephonyResult<null>> {
      const failure = takeFailure('release');
      if (failure) return { ok: false, error: failure };
      const record = provisioned.get(providerSid);
      if (record) {
        provisioned.delete(providerSid);
        available.push(record.e164);
      }
      // Idempotent: releasing an unknown SID is success, per the contract.
      return { ok: true, data: null };
    },
  };
}
