// =============================================================================
// El aviso que recibe el negocio cuando el bot deriva una conversación.
// Lo que importa aquí es qué dice: si el canal admite respuesta, el correo
// invita a contestar; si es el chat de la web, avisa de que no se puede,
// porque prometerlo sería mentir. Ver src/lib/handoff-alert-email.ts.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { buildHandoffAlertEmail } from '@/lib/handoff-alert-email';
import { HANDOFF_CHANNELS } from '@/lib/chatbot-handoff';

const BASE = {
  businessName: 'Clínica Orly',
  conversationId: 'conv_1',
  channel: 'telegram',
  lastMessage: '¿Me podéis dar hora para el jueves?',
  reason: 'no hay agenda configurada',
};

describe('buildHandoffAlertEmail', () => {
  it('dice el canal, lo que escribieron y el motivo, y enlaza la conversación', () => {
    const mail = buildHandoffAlertEmail(BASE);

    expect(mail.subject).toContain('Telegram');
    expect(mail.text).toContain('¿Me podéis dar hora para el jueves?');
    expect(mail.text).toContain('no hay agenda configurada');
    expect(mail.text).toContain('/portal/conversations/conv_1');
    expect(mail.html).toContain('/portal/conversations/conv_1');
  });

  it('en los canales con respuesta, invita a contestar desde el portal', () => {
    const mail = buildHandoffAlertEmail(BASE);
    expect(mail.text).toContain('Puedes contestarle tú desde el portal');
  });

  it('en el chat de la web avisa de que no se puede contestar', () => {
    const mail = buildHandoffAlertEmail({ ...BASE, channel: 'web' });

    expect(mail.subject).toContain('el chat de tu web');
    expect(mail.text).toContain('no se puede contestar');
    expect(mail.text).not.toContain('Puedes contestarle tú desde el portal');
  });

  it('aguanta sin motivo', () => {
    const mail = buildHandoffAlertEmail({ ...BASE, reason: null });
    expect(mail.text).not.toContain('Motivo:');
  });

  it('recorta un mensaje larguísimo en vez de mandarlo entero', () => {
    const mail = buildHandoffAlertEmail({ ...BASE, lastMessage: 'a'.repeat(900) });
    expect(mail.text).toContain('…');
    expect(mail.text.length).toBeLessThan(900);
  });

  it('escapa el HTML de lo que escribió un desconocido', () => {
    const mail = buildHandoffAlertEmail({ ...BASE, lastMessage: '<script>robar()</script>' });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  // La lista de canales con respuesta está copiada en el módulo del email
  // para no arrastrar el resto de chatbot-handoff. Copiada, no divergente:
  // si alguien añade un canal allí y no aquí, el negocio recibiría "no se
  // puede contestar" para un canal donde sí se puede.
  it('trata como contestables exactamente los mismos canales que la bandeja', () => {
    for (const channel of HANDOFF_CHANNELS) {
      expect(buildHandoffAlertEmail({ ...BASE, channel }).text).toContain('Puedes contestarle tú desde el portal');
    }
    expect(buildHandoffAlertEmail({ ...BASE, channel: 'web' }).text).not.toContain('Puedes contestarle tú desde el portal');
  });
});
