// =============================================================================
// lib/contact-notice.ts — cuándo se considera que alguien ha escrito sus datos
// de contacto, y el aviso que se añade a la respuesta del bot.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { containsContactData, contactNoticeText, withContactNotice } from '@/lib/contact-notice';

describe('containsContactData', () => {
  it.each([
    'mi correo es ana.garcia@correo.example',
    'llamadme al 600123456',
    'mi móvil: 600 12 34 56',
    '+34 928 000 000',
    'tel. (928) 00-00-00',
    'whatsapp +44 7700 900123',
  ])('detecta «%s»', (text) => {
    expect(containsContactData(text)).toBe(true);
  });

  it.each([
    'quiero pedir cita para el martes',
    'vivo en el 35001',
    'el blanqueamiento cuesta 250 €, ¿y el de 2024?',
    'a las 10:30 del 12/12/2026',
    'escríbeme a ana @ casa',
  ])('no confunde «%s»', (text) => {
    expect(containsContactData(text)).toBe(false);
  });
});

describe('contactNoticeText', () => {
  it('usa el texto aprobado en el paso 6, entre comillas, con el nombre del negocio', () => {
    const text = contactNoticeText({ captacion: { texto_consentimiento: '  Acepto la política.  ' } }, 'Clínica Orly');
    expect(text).toContain('Clínica Orly los usará para responder a tu consulta');
    expect(text).toContain('«Acepto la política.»');
  });

  it('sin texto aprobado, uno genérico', () => {
    expect(contactNoticeText({ captacion: {} }, 'X')).toContain('solo para gestionar tu consulta');
    expect(contactNoticeText({ captacion: { texto_consentimiento: '   ' } }, 'X')).toContain('solo para gestionar tu consulta');
  });

  it('va detrás de la respuesta, separado por una línea en blanco', () => {
    expect(withContactNotice('Hola', 'Aviso')).toBe('Hola\n\nAviso');
  });
});
