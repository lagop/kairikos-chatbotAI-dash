// =============================================================================
// Fase D — los enlaces con los que el cliente escribe A MANO a un prospecto.
// Ver lib/lead-contact-links.ts.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { suggestedOutreachMessage, whatsappLink, mailtoLink } from '@/lib/lead-contact-links';

const MESSAGE = suggestedOutreachMessage({ businessName: 'Reformas Orly', prospectName: 'Ferretería Central' });

describe('suggestedOutreachMessage', () => {
  it('se identifica desde la primera línea: sin eso, un mensaje en frío se reporta', () => {
    expect(MESSAGE).toContain('Reformas Orly');
    expect(MESSAGE.startsWith('Hola, Ferretería Central')).toBe(true);
  });

  it('sin nombre del prospecto sigue leyéndose bien', () => {
    const plain = suggestedOutreachMessage({ businessName: 'Reformas Orly', prospectName: null });
    expect(plain.startsWith('Hola. Te escribo de Reformas Orly')).toBe(true);
    expect(plain).not.toContain('Hola, .');
  });
});

describe('whatsappLink', () => {
  it('añade el 34 a un móvil español de nueve dígitos y codifica el texto', () => {
    const link = whatsappLink('620 41 08 96', MESSAGE);
    expect(link?.startsWith('https://wa.me/34620410896?text=')).toBe(true);
    expect(link).toContain(encodeURIComponent('Reformas Orly'));
    expect(link).not.toContain(' ');
  });

  it('respeta un número que ya trae prefijo internacional', () => {
    expect(whatsappLink('+34 620 410 896', 'hola')).toContain('wa.me/34620410896');
    expect(whatsappLink('+44 7700 900123', 'hola')).toContain('wa.me/447700900123');
  });

  it('devuelve null cuando no hay número al que escribir', () => {
    for (const bad of [null, undefined, '', 'sin teléfono', '12345', '1'.repeat(16)]) {
      expect(whatsappLink(bad, 'hola')).toBeNull();
    }
  });
});

describe('mailtoLink', () => {
  it('lleva asunto y cuerpo con espacios que los gestores de correo entienden', () => {
    const link = mailtoLink('info@ferreteria.example', { subject: 'Reformas Orly', body: MESSAGE });
    expect(link?.startsWith('mailto:info@ferreteria.example?')).toBe(true);
    expect(link).toContain('subject=Reformas%20Orly');
    // '+' en el cuerpo de un mailto se ve literalmente como '+'.
    expect(link).not.toContain('+');
  });

  it('devuelve null si el correo no es válido', () => {
    for (const bad of [null, undefined, '', 'info@ferreteria', 'dos@correos@example.com', 'hola']) {
      expect(mailtoLink(bad, { subject: 'x', body: 'y' })).toBeNull();
    }
  });
});
