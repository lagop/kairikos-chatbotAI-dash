// =============================================================================
// Cartera — los enlaces de los correos (20/11/2026). En los primeros correos de
// producción las URL iban como texto y algunos clientes no las enlazaban. Ahora
// son <a>, pero en el aviso de contacto solo las que monta el portal: lo que
// escribe el comprador en el formulario público nunca sale como enlace.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { linkify, renderAgencyFailedEmail, renderOperatorFailedEmail, renderOwnerExitEmail } from '@/lib/cartera/emails';
import { renderAgencyEnquiryEmail, type EnquiryHome } from '@/lib/cartera/enquiry-rules';

const home: EnquiryHome = {
  ref: 'C-101',
  operation: 'venta',
  title: { es: 'Villa con vistas', en: 'Villa with views', de: 'Villa mit Blick' },
  slugs: { es: 'villa-con-vistas-c-101', en: 'villa-with-views-c-101', de: 'villa-mit-blick-c-101' },
  amount: 850000,
};

describe('linkify', () => {
  it('enlaza http(s) y deja fuera la puntuación del final', () => {
    expect(linkify('Tu panel: https://portal.example/portal/cartera.')).toBe('Tu panel: <a href="https://portal.example/portal/cartera">https://portal.example/portal/cartera</a>.');
    expect(linkify('Sin enlaces aquí')).toBe('Sin enlaces aquí');
  });

  it('un & ya escapado sigue escapado en el href', () => {
    expect(linkify('https://x.example/?a=1&amp;b=2')).toBe('<a href="https://x.example/?a=1&amp;b=2">https://x.example/?a=1&amp;b=2</a>');
  });
});

describe('aviso de contacto a la agencia', () => {
  const email = renderAgencyEnquiryEmail({
    kind: 'question',
    name: 'Ana https://malo.example',
    contact: 'ana@example.com',
    lang: 'es',
    consentAt: new Date('2026-11-20T10:00:00Z'),
    summary: 'Mira esto: https://phishing.example/login',
    refs: ['C-101'],
    homes: new Map([['C-101', home]]),
    siteUrl: 'https://agencia.example',
    panelUrl: 'https://portal.example/portal/cartera',
  });

  it('la ficha y el panel son enlaces', () => {
    expect(email.html).toContain('<a href="https://agencia.example/comprar/villa-con-vistas-c-101/">https://agencia.example/comprar/villa-con-vistas-c-101/</a>');
    expect(email.html).toContain('<p>Todos tus contactos: <a href="https://portal.example/portal/cartera">https://portal.example/portal/cartera</a></p>');
    expect(email.html).toContain('<p>C-101 · Villa con vistas — <a href=');
  });

  it('lo que escribió el comprador no se enlaza', () => {
    expect(email.html).not.toContain('href="https://phishing.example');
    expect(email.html).not.toContain('href="https://malo.example');
    expect(email.html).toContain('Mira esto: https://phishing.example/login');
    expect(email.html.match(/<a /g)).toHaveLength(2);
  });

  it('el texto plano no cambia', () => {
    expect(email.text).toContain('C-101 · Villa con vistas — https://agencia.example/comprar/villa-con-vistas-c-101/');
    expect(email.text).not.toContain('<a');
  });
});

describe('los demás correos de la cartera', () => {
  it('el de baja enlaza el panel', () => {
    const email = renderOwnerExitEmail({ agencyName: 'Agencia', siteUrl: 'https://agencia.example', graceEndsAt: new Date('2026-12-20T10:00:00Z'), homeCount: 1, enquiryCount: 2 });
    expect(email.html).toMatch(/Tu panel: <a href="https?:\/\/[^"]+\/portal\/cartera">/);
  });

  it('el de publicación fallida enlaza el panel a la agencia y la ejecución al operador', () => {
    const info = {
      siteUrl: 'https://agencia.example',
      githubRepo: 'lagop/web-prueba',
      buildId: 'b-1',
      trigger: 'manual',
      stage: 'construir',
      error: 'falló',
      runUrl: 'https://github.com/lagop/web-prueba/actions/runs/1',
      clientId: 'client-1',
    };
    expect(renderAgencyFailedEmail(info).html).toMatch(/Tu panel: <a href="https?:\/\/[^"]+\/portal\/cartera">/);
    expect(renderOperatorFailedEmail(info).html).toContain('<a href="https://github.com/lagop/web-prueba/actions/runs/1">');
  });
});
