// =============================================================================
// Unit tests for src/lib/web-quote-email.ts.
//
// Resend itself is loaded via a dynamic `(0, eval)('require')` (see the
// file's own header comment — deliberate, to dodge Edge/webpack bundling
// of the SDK) rather than a static import, so — same as
// review-request-campaign.test.ts — these tests exercise the real
// no-RESEND_API_KEY / no-recipient skip branches (never actually
// invoking Resend) plus the pure content-builder functions, which cover
// the copy/formatting logic without touching the network layer at all.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  sendWebQuoteSentEmail,
  sendWebQuoteInvoiceEmail,
  buildWebQuoteSentEmail,
  buildWebQuoteInvoiceEmail,
} from '@/lib/web-quote-email';

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
});

describe('sendWebQuoteSentEmail — skip branches', () => {
  it('skips with reason no_recipient when "to" has no @', async () => {
    const result = await sendWebQuoteSentEmail({
      to: '',
      businessName: 'Peluquería Aurora',
      amountCents: 99900,
      currency: 'eur',
      description: 'Sitio web a medida',
    });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_recipient' });
  });

  it('skips with reason no_api_key when RESEND_API_KEY is not configured', async () => {
    const result = await sendWebQuoteSentEmail({
      to: 'aurora@example.com',
      businessName: 'Peluquería Aurora',
      amountCents: 99900,
      currency: 'eur',
      description: 'Sitio web a medida',
    });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_api_key' });
  });
});

describe('sendWebQuoteInvoiceEmail — skip branches', () => {
  it('skips with reason no_recipient when "to" has no @', async () => {
    const result = await sendWebQuoteInvoiceEmail({
      to: 'not-an-email',
      businessName: 'Peluquería Aurora',
      amountCents: 40000,
      currency: 'eur',
      role: 'deposit',
      hostInvoiceUrl: null,
    });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_recipient' });
  });

  it('skips with reason no_api_key when RESEND_API_KEY is not configured', async () => {
    const result = await sendWebQuoteInvoiceEmail({
      to: 'aurora@example.com',
      businessName: 'Peluquería Aurora',
      amountCents: 40000,
      currency: 'eur',
      role: 'final',
      hostInvoiceUrl: null,
    });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_api_key' });
  });
});

describe('buildWebQuoteSentEmail', () => {
  it('includes the formatted amount and description in subject/text/html', () => {
    const rendered = buildWebQuoteSentEmail({
      businessName: 'Peluquería Aurora',
      amountCents: 99900,
      currency: 'eur',
      description: 'Sitio web a medida — 5 páginas',
    });
    expect(rendered.subject).toContain('999,00');
    expect(rendered.text).toContain('Peluquería Aurora');
    expect(rendered.text).toContain('Sitio web a medida — 5 páginas');
    expect(rendered.html).toContain('Sitio web a medida — 5 páginas');
    expect(rendered.html).toContain('/portal/web');
  });

  it('escapes HTML-significant characters from the description', () => {
    const rendered = buildWebQuoteSentEmail({
      businessName: 'Aurora & Co',
      amountCents: 10000,
      currency: 'eur',
      description: '<script>alert(1)</script>',
    });
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });
});

describe('buildWebQuoteInvoiceEmail', () => {
  it.each([
    ['full', 'tu factura'],
    ['deposit', 'adelanto'],
    ['final', 'saldo final'],
  ] as const)('role=%s uses distinct copy mentioning "%s"', (role, expectedFragment) => {
    const rendered = buildWebQuoteInvoiceEmail({
      businessName: 'Peluquería Aurora',
      amountCents: 40000,
      currency: 'eur',
      role,
      hostInvoiceUrl: 'https://invoice.stripe.com/i/test',
    });
    expect(rendered.subject.toLowerCase()).toContain(expectedFragment);
    expect(rendered.html).toContain('https://invoice.stripe.com/i/test');
  });

  it('falls back to the portal URL when hostInvoiceUrl is null', () => {
    const rendered = buildWebQuoteInvoiceEmail({
      businessName: 'Peluquería Aurora',
      amountCents: 40000,
      currency: 'eur',
      role: 'full',
      hostInvoiceUrl: null,
    });
    expect(rendered.html).toContain('/portal/web');
    expect(rendered.html).not.toContain('stripe.com');
  });
});
