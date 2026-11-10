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
  buildCustomCareOfferEmail,
  sendCustomCareOfferEmail,
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
      monthlyCents: null,
      monthlyStartsAfterMonths: 12,
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
      monthlyCents: null,
      monthlyStartsAfterMonths: 12,
    });
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  // 11/11/2026 — mantenimiento a medida.
  it('con cuota, dice cuánto y desde cuándo se cobra', () => {
    const rendered = buildWebQuoteSentEmail({
      businessName: 'Aurora',
      amountCents: 250000,
      currency: 'eur',
      description: 'Web premium',
      monthlyCents: 8900,
      monthlyStartsAfterMonths: 12,
    });
    for (const body of [rendered.text, rendered.html]) {
      expect(body).toContain('89,00');
      expect(body).toContain('Los 12 primeros meses van incluidos');
    }
  });

  it('sin cuota, dice que no hay mantenimiento y qué pasa con la web', () => {
    const rendered = buildWebQuoteSentEmail({
      businessName: 'Aurora',
      amountCents: 250000,
      currency: 'eur',
      description: 'Web premium',
      monthlyCents: null,
      monthlyStartsAfterMonths: 12,
    });
    for (const body of [rendered.text, rendered.html]) {
      expect(body).toContain('Sin mantenimiento');
      expect(body).toContain('te entregamos la web');
    }
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

// 10/11/2026 — oferta de mantenimiento «solo mantenimiento».
describe('buildCustomCareOfferEmail', () => {
  const BASE = { businessName: 'Aurora & Co', priceCents: 4900, currency: 'eur', trialMonths: 0, webClientProductId: 'cp_web_1' };

  it('dice el precio, cómo activarlo y enlaza a la página de SU web', () => {
    const r = buildCustomCareOfferEmail(BASE);
    expect(r.subject).toContain('49,00');
    expect(r.text).toContain('guarda tu tarjeta');
    expect(r.text).toContain('La primera cuota se cobra al activarlo');
    expect(r.text).toContain('Sin permanencia');
    expect(r.text).toMatch(/\/portal\/web\/cp_web_1$/m);
    expect(r.html).toContain('/portal/web/cp_web_1');
    expect(r.html).toContain('Aurora &amp; Co');
  });

  it('con meses sin cobrar, los cuenta desde la activación y no da una fecha', () => {
    const r = buildCustomCareOfferEmail({ ...BASE, trialMonths: 12 });
    expect(r.text).toContain('no se te cobra nada: la primera cuota llega 12 meses después');
    expect(r.text).not.toMatch(/\b20\d\d\b/);
    expect(buildCustomCareOfferEmail({ ...BASE, trialMonths: 1 }).text).toContain('al mes siguiente');
  });

  it('sin clave de Resend no envía, y lo dice', async () => {
    const res = await sendCustomCareOfferEmail({ ...BASE, to: 'cliente@example.com' });
    expect(res).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_api_key' });
  });
});
