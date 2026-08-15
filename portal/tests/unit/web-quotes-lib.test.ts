// =============================================================================
// Unit tests for the pure helpers added to src/lib/web-quotes.ts in
// WebQuote v2: canVoidInvoice, resolveDepositPlan.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { canVoidInvoice, resolveDepositPlan } from '@/lib/web-quotes';

describe('canVoidInvoice', () => {
  it('allows invoiced/invoiced_deposit/invoiced_final', () => {
    expect(canVoidInvoice('invoiced')).toBe(true);
    expect(canVoidInvoice('invoiced_deposit')).toBe(true);
    expect(canVoidInvoice('invoiced_final')).toBe(true);
  });

  it('rejects every other status, including deposit_paid and paid (no refund path)', () => {
    for (const status of ['draft', 'sent', 'accepted', 'deposit_paid', 'paid', 'cancelled']) {
      expect(canVoidInvoice(status)).toBe(false);
    }
  });
});

describe('resolveDepositPlan', () => {
  it('reports hasDeposit=false and finalCents=amountCents when depositCents is null', () => {
    expect(resolveDepositPlan({ amountCents: 99900, depositCents: null })).toEqual({
      hasDeposit: false,
      depositCents: null,
      finalCents: 99900,
    });
  });

  it('splits amountCents into deposit/final when depositCents is set', () => {
    expect(resolveDepositPlan({ amountCents: 87500, depositCents: 30000 })).toEqual({
      hasDeposit: true,
      depositCents: 30000,
      finalCents: 57500,
    });
  });
});
