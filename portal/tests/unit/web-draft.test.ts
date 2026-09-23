// =============================================================================
// A11, capa 1 — unit tests del parseo de la respuesta del modelo y de la
// elección de plantilla.
//
// Lo que se fija aquí es lo que ya mordió en el informe comparativo, aplicado
// al borrador: que lo que se enseña a un negocio real no contenga basura ni
// cosas a medias. Un borrador sin titular, con quince servicios inventados o
// con un JSON envuelto en vallas de markdown es peor que no enseñar nada.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { parseWebDraftResponse } from '@/lib/web-draft-ai';
import {
  themeFor,
  renderWebDraftHtml,
  formatSpanishPhone,
  heroImageUrls,
  DEFAULT_WEB_DRAFT_OFFER,
} from '@/lib/web-draft-html';

const VALID = JSON.stringify({
  headline: 'Peluquería en Las Palmas con cita previa',
  subheadline: 'Corte, color y peinado en el centro de la ciudad.',
  about: 'Un salón de barrio con clientela fiel.',
  services: [
    { name: 'Corte', description: 'Corte y peinado para todo tipo de cabello.' },
    { name: 'Color', description: 'Coloración y mechas.' },
  ],
  callToAction: 'Pide tu cita por teléfono',
});

describe('parseWebDraftResponse', () => {
  it('parsea una respuesta correcta', () => {
    const copy = parseWebDraftResponse(VALID);
    expect(copy?.headline).toContain('Peluquería');
    expect(copy?.services).toHaveLength(2);
  });

  it('quita la valla de markdown, que Haiku pone aunque el prompt lo prohíba', () => {
    expect(parseWebDraftResponse('```json\n' + VALID + '\n```')?.headline).toBeTruthy();
  });

  it('sin titular no hay borrador: una portada sin titular es peor que nada', () => {
    expect(parseWebDraftResponse(JSON.stringify({ subheadline: 'algo', services: [] }))).toBeNull();
  });

  it('JSON malformado devuelve null en vez de lanzar', () => {
    expect(parseWebDraftResponse('esto no es json')).toBeNull();
    expect(parseWebDraftResponse('')).toBeNull();
  });

  it('tolera que falte todo menos el titular', () => {
    const copy = parseWebDraftResponse(JSON.stringify({ headline: 'Fontanería en Elche' }));
    expect(copy).not.toBeNull();
    expect(copy?.services).toEqual([]);
    expect(copy?.about).toBe('');
  });

  it('recorta a 6 servicios y descarta los que vienen sin nombre', () => {
    const copy = parseWebDraftResponse(
      JSON.stringify({
        headline: 'X',
        services: [
          ...Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, description: 'd' })),
          { description: 'sin nombre' },
        ],
      }),
    );
    expect(copy?.services).toHaveLength(6);
    expect(copy?.services.every((s) => s.name.length > 0)).toBe(true);
  });

  it('corta los textos largos en vez de romper la maquetación', () => {
    const copy = parseWebDraftResponse(
      JSON.stringify({ headline: 'a'.repeat(500), about: 'b'.repeat(2000) }),
    );
    expect(copy!.headline.length).toBeLessThanOrEqual(90);
    expect(copy!.about.length).toBeLessThanOrEqual(400);
  });

  it('ignora servicios que no son objetos', () => {
    const copy = parseWebDraftResponse(JSON.stringify({ headline: 'X', services: ['corte', 42, null] }));
    expect(copy?.services).toEqual([]);
  });
});

describe('themeFor', () => {
  it('cada familia de sector tiene su paleta', () => {
    expect(themeFor('hair_salon').key).toBe('beauty');
    expect(themeFor('plumber').key).toBe('trades');
    expect(themeFor('dentist').key).toBe('health');
    expect(themeFor('lawyer').key).toBe('professional');
  });

  it('un sector desconocido cae a oficios, que es el sector principal', () => {
    expect(themeFor('gato_de_tres_cabezas').key).toBe('trades');
    expect(themeFor(null).key).toBe('trades');
  });
});

// 23/09/2026 — del primer borrador real: el teléfono salía cuatro veces y
// como +34928040058, que en una portada parece un número de serie.
describe('formatSpanishPhone', () => {
  it('parte un número español con prefijo', () => {
    expect(formatSpanishPhone('+34928040058')).toBe('928 04 00 58');
  });

  it('parte también uno sin prefijo y con espacios de Google', () => {
    expect(formatSpanishPhone('928 040 058')).toBe('928 04 00 58');
  });

  it('un número que no encaja se deja crudo: mejor crudo que mal cortado', () => {
    expect(formatSpanishPhone('+33 1 42 00 00 00')).toBe('+33 1 42 00 00 00');
    expect(formatSpanishPhone('sin teléfono')).toBe('sin teléfono');
  });
});

describe('heroImageUrls', () => {
  it('propone la foto del sector y, detrás, el degradado de respaldo', () => {
    expect(heroImageUrls(themeFor('hair_salon'))).toEqual(['/web-draft/beauty.jpg', '/web-draft/beauty.svg']);
  });
});

describe('renderWebDraftHtml', () => {
  const copy = parseWebDraftResponse(VALID)!;
  const subject = {
    businessName: 'Peluquería "Ejemplo" & Co',
    primaryType: 'hair_salon',
    city: 'Las Palmas',
    address: 'Calle Mayor 1',
    phone: '+34 928 00 00 00',
    rating: 4.9,
    reviewCount: 1129,
  };

  it('escapa el nombre del negocio, que viene de Google', () => {
    const html = renderWebDraftHtml({ subject, copy, generatedAt: new Date('2026-09-23') });
    expect(html).toContain('&quot;Ejemplo&quot;');
    expect(html).toContain('&amp; Co');
    expect(html).not.toContain('Peluquería "Ejemplo" & Co');
  });

  it('deja claro que es una propuesta, no su web publicada', () => {
    const html = renderWebDraftHtml({ subject, copy, generatedAt: new Date('2026-09-23') });
    expect(html).toContain('Propuesta de Kairikos');
    expect(html).toContain('todavía no publicado');
  });

  // Sin punto en 1129 y con punto en 11.290: en español los números de cuatro
  // cifras NO se agrupan. Parecía un fallo de formato en el informe
  // comparativo y resultó ser la tipografía correcta; queda fijado aquí para
  // que nadie lo "arregle" metiendo un punto que no toca.
  it('enseña las reseñas reales con la tipografía española', () => {
    const html = renderWebDraftHtml({ subject, copy, generatedAt: new Date('2026-09-23') });
    expect(html).toMatch(/1129 reseñas/);
    const big = renderWebDraftHtml({
      subject: { ...subject, reviewCount: 11290 },
      copy,
      generatedAt: new Date('2026-09-23'),
    });
    expect(big).toMatch(/11\.290 reseñas/);
  });

  it('sin valoración no inventa una sección de reseñas', () => {
    const html = renderWebDraftHtml({
      subject: { ...subject, rating: null, reviewCount: null },
      copy,
      generatedAt: new Date('2026-09-23'),
    });
    expect(html).not.toContain('reseñas en Google');
  });

  it('escribe el teléfono como se lee en España, no como lo guarda Google', () => {
    const html = renderWebDraftHtml({ subject, copy, generatedAt: new Date('2026-09-23') });
    expect(html).toContain('928 00 00 00');
    // El href sí lleva el formato marcable, con prefijo y sin espacios.
    expect(html).toContain('href="tel:+34928000000"');
  });

  it('sin teléfono no pinta un botón de llamar roto', () => {
    const html = renderWebDraftHtml({
      subject: { ...subject, phone: null },
      copy,
      generatedAt: new Date('2026-09-23'),
    });
    expect(html).not.toContain('href="tel:');
  });

  it('cierra con la oferta, que es para lo que existe el borrador', () => {
    const html = renderWebDraftHtml({ subject, copy, generatedAt: new Date('2026-09-23') });
    expect(html).toContain(DEFAULT_WEB_DRAFT_OFFER.priceLabel);
    expect(html).toContain(DEFAULT_WEB_DRAFT_OFFER.daysLabel);
  });

  it('nunca se indexa: es información de un negocio de terceros', () => {
    const html = renderWebDraftHtml({ subject, copy, generatedAt: new Date('2026-09-23') });
    expect(html).toContain('noindex');
  });
});
