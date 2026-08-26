// =============================================================================
// Unit tests for src/lib/leads-email.ts.
//
// Same reasoning as web-quote-email.test.ts: Resend is loaded via a
// dynamic `(0, eval)('require')`, so these exercise the real
// no-RESEND_API_KEY / no-recipient skip branches (never actually
// invoking Resend) plus the pure content-builder function.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  sendNewLeadEmail,
  buildNewLeadEmail,
  sendProspectingBatchEmail,
  buildProspectingBatchEmail,
} from '@/lib/leads-email';

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
});

const VARS = {
  businessName: 'Peluquería Aurora',
  contactName: 'Marcos Ferreiro',
  contactPhone: '+34611223344',
  contactEmail: null,
  summary: 'Pregunta por presupuesto de reforma de baño completo.',
  score: 78,
  scoreReason: 'Pregunta precio exacto y quiere cita esta semana.',
  channel: 'whatsapp',
};

describe('sendNewLeadEmail — skip branches', () => {
  it('skips with reason no_recipient when "to" has no @', async () => {
    const result = await sendNewLeadEmail({ to: '', ...VARS });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_recipient' });
  });

  it('skips with reason no_api_key when RESEND_API_KEY is not configured', async () => {
    const result = await sendNewLeadEmail({ to: 'aurora@example.com', ...VARS });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_api_key' });
  });
});

describe('buildNewLeadEmail', () => {
  it('names the contact, the channel, and the priority in the subject', () => {
    const { subject } = buildNewLeadEmail(VARS);
    expect(subject).toContain('Marcos Ferreiro');
    expect(subject).toContain('78');
  });

  it('includes the contact details, channel, summary, and a link to /portal/leads', () => {
    const { text, html } = buildNewLeadEmail(VARS);
    for (const rendered of [text, html]) {
      expect(rendered).toContain('Marcos Ferreiro');
      expect(rendered).toContain('+34611223344');
      expect(rendered).toContain('WhatsApp');
      expect(rendered).toContain('reforma de baño');
      expect(rendered).toContain('/portal/leads');
    }
  });

  it('falls back to "sin datos de contacto" when every contact field is null', () => {
    const { text } = buildNewLeadEmail({ ...VARS, contactName: null, contactPhone: null, contactEmail: null });
    expect(text).toContain('sin datos de contacto');
  });

  it('omits the priority parenthetical when score is null', () => {
    const { subject } = buildNewLeadEmail({ ...VARS, score: null });
    expect(subject).not.toContain('prioridad');
  });

  it('escapes HTML in the AI-extracted summary — it is untrusted, LLM-generated text', () => {
    const { html } = buildNewLeadEmail({ ...VARS, summary: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes the score reason next to the score, and escapes HTML in it too', () => {
    const { text, html } = buildNewLeadEmail(VARS);
    expect(text).toContain('Pregunta precio exacto');
    expect(html).toContain('Pregunta precio exacto');

    const { html: escapedHtml } = buildNewLeadEmail({ ...VARS, scoreReason: '<img src=x onerror=alert(1)>' });
    expect(escapedHtml).not.toContain('<img');
  });

  it('omits the score-reason line entirely when there is none', () => {
    const { text } = buildNewLeadEmail({ ...VARS, scoreReason: null });
    expect(text).not.toContain('Por qué esta puntuación');
  });
});

describe('sendProspectingBatchEmail — skip branches', () => {
  it('skips with reason no_recipient when "to" has no @', async () => {
    const result = await sendProspectingBatchEmail({ to: '', businessName: 'Ferretería Central', count: 3 });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_recipient' });
  });

  it('skips with reason no_api_key when RESEND_API_KEY is not configured', async () => {
    const result = await sendProspectingBatchEmail({ to: 'a@b.com', businessName: 'Ferretería Central', count: 3 });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_api_key' });
  });
});

describe('buildProspectingBatchEmail', () => {
  it('singular vs plural depending on count, always includes /portal/leads', () => {
    const one = buildProspectingBatchEmail({ businessName: 'Aurora', count: 1 });
    expect(one.subject).toContain('1 prospecto nuevo');
    expect(one.subject).not.toContain('prospectos');

    const many = buildProspectingBatchEmail({ businessName: 'Aurora', count: 5 });
    expect(many.subject).toContain('5 prospectos nuevos');
    expect(many.text).toContain('/portal/leads');
    expect(many.html).toContain('/portal/leads');
  });

  it('escapes the business name in html', () => {
    const { html } = buildProspectingBatchEmail({ businessName: '<b>Aurora</b>', count: 2 });
    expect(html).not.toContain('<b>Aurora</b>');
    expect(html).toContain('&lt;b&gt;');
  });
});
