// =============================================================================
// Unit tests for src/lib/leads-email.ts.
//
// Same reasoning as web-quote-email.test.ts: Resend is loaded via a
// dynamic `(0, eval)('require')`, so these exercise the real
// no-RESEND_API_KEY / no-recipient skip branches (never actually
// invoking Resend) plus the pure content-builder function.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { sendNewLeadEmail, buildNewLeadEmail } from '@/lib/leads-email';

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
});
