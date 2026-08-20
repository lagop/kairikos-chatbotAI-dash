// =============================================================================
// Canales Fase 7 — unit tests for src/lib/conversation-digest-email.ts.
// Same shape as tests/unit/web-quote-email.test.ts — Resend is loaded via
// dynamic require, so these tests exercise the skip branches and the
// pure content-builder function without touching the network layer.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { sendConversationDigestEmail, buildConversationDigestEmail } from '@/lib/conversation-digest-email';

beforeEach(() => {
  delete process.env.RESEND_API_KEY;
});

describe('sendConversationDigestEmail — skip branches', () => {
  const baseInput = {
    businessName: 'Clínica Orly',
    totalConversations: 5,
    escalatedCount: 1,
    summaryText: 'Todo tranquilo hoy.',
    highlights: ['Un cliente preguntó por horarios de fin de semana.'],
  };

  it('skips with reason no_recipient when "to" has no @', async () => {
    const result = await sendConversationDigestEmail({ ...baseInput, to: 'not-an-email' });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_recipient' });
  });

  it('skips with reason no_api_key when RESEND_API_KEY is not configured', async () => {
    const result = await sendConversationDigestEmail({ ...baseInput, to: 'orly@example.com' });
    expect(result).toEqual({ ok: true, skipped: true, messageId: null, reason: 'no_api_key' });
  });
});

describe('buildConversationDigestEmail', () => {
  it('includes the summary, highlights and a link back to the portal', () => {
    const rendered = buildConversationDigestEmail({
      businessName: 'Clínica Orly',
      totalConversations: 12,
      escalatedCount: 2,
      summaryText: 'Se atendieron 12 conversaciones, 2 derivadas a un humano.',
      highlights: ['Reservar mesa para 8 el sábado', 'Confirmar horario de Navidad'],
    });
    expect(rendered.subject).toContain('12 conversaciones');
    expect(rendered.subject).toContain('2 derivadas');
    expect(rendered.text).toContain('Clínica Orly');
    expect(rendered.text).toContain('Reservar mesa para 8 el sábado');
    expect(rendered.html).toContain('Confirmar horario de Navidad');
    expect(rendered.html).toContain('/portal/conversations');
  });

  it('omits the "derivadas" subject fragment when escalatedCount is 0', () => {
    const rendered = buildConversationDigestEmail({
      businessName: 'X',
      totalConversations: 3,
      escalatedCount: 0,
      summaryText: 'Todo resuelto.',
      highlights: [],
    });
    expect(rendered.subject).not.toContain('derivadas');
  });

  it('shows a neutral message when there are no highlights', () => {
    const rendered = buildConversationDigestEmail({
      businessName: 'X',
      totalConversations: 3,
      escalatedCount: 0,
      summaryText: 'Todo resuelto.',
      highlights: [],
    });
    expect(rendered.text).toContain('Nada que requiera tu atención');
  });

  it('escapes HTML-significant characters from the summary and highlights', () => {
    const rendered = buildConversationDigestEmail({
      businessName: 'Aurora & Co',
      totalConversations: 1,
      escalatedCount: 0,
      summaryText: '<script>alert(1)</script>',
      highlights: ['<b>urgente</b>'],
    });
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).not.toContain('<b>urgente</b>');
  });
});
