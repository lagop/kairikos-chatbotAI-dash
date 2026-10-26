// =============================================================================
// 26/10/2026 — el borrador de web con datos reales de Google (A11, tercera
// versión): reseñas filtradas, citas literales, horario, dirección al día y
// secciones que desaparecen cuando Google no da el dato.
//
// Los datos son INVENTADOS a propósito, aunque el caso de partida fue un
// negocio real (Fontanería Suárez): las reseñas de un tercero no se copian a
// un repositorio, y las condiciones de Google tampoco dejan guardarlas.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  shortAuthorName,
  sharesSurname,
  filterDraftReviews,
  resolveHighlights,
  renderableHighlights,
  groupOpeningHours,
  openEveryDaySummary,
  quoteHash,
  type DraftReview,
} from '@/lib/web-draft-reviews';
import { mapPlaceDraftData, type PlaceReview, type PlaceDraftData } from '@/lib/google-places';
import { withLiveData, addressFromLeadSummary } from '@/lib/web-draft-subject';
import { parseWebDraftResponse } from '@/lib/web-draft-ai';
import { renderWebDraftHtml, GOOGLE_MAPS_LOGO_DARK, GOOGLE_MAPS_LOGO_WHITE } from '@/lib/web-draft-html';
import { isLiveEntryFresh, LIVE_CACHE_TTL_MS } from '@/lib/web-draft-live';
import { stripDraftChrome } from '@/lib/website-build';

const BUSINESS = 'Fontanería Ejemplo';

function review(over: Partial<PlaceReview> = {}): PlaceReview {
  return {
    name: over.name ?? 'places/p1/reviews/r1',
    rating: over.rating === undefined ? 5 : over.rating,
    text: over.text ?? 'Localiza las averías muy rápido y no rompe nada. Muy limpio.',
    translated: over.translated ?? false,
    authorName: over.authorName === undefined ? 'Andrés Molina Pérez' : over.authorName,
    authorUri: over.authorUri ?? 'https://www.google.com/maps/contrib/1',
    relativeTime: over.relativeTime ?? 'Hace un año',
  };
}

const HOURS_ALL_WEEK = [
  'lunes: 8:00–20:00',
  'martes: 8:00–20:00',
  'miércoles: 8:00–20:00',
  'jueves: 8:00–20:00',
  'viernes: 8:00–20:00',
  'sábado: 8:00–20:00',
  'domingo: 8:00–20:00',
];

describe('shortAuthorName', () => {
  it('nombre e inicial del primer apellido', () => {
    expect(shortAuthorName('Andrés Molina Pérez')).toBe('Andrés M.');
  });
  it('una sola palabra se deja; vacío no deja la cita sin firma', () => {
    expect(shortAuthorName('Lucía')).toBe('Lucía');
    expect(shortAuthorName(null)).toBe('Cliente de Google');
  });
});

describe('sharesSurname', () => {
  it('quien comparte apellido con el negocio es posible familia', () => {
    expect(sharesSurname('María Ejemplo', BUSINESS)).toBe(true);
    expect(sharesSurname('María Ejémplo', BUSINESS)).toBe(true); // sin tildes
  });
  it('el nombre de pila no cuenta, ni las palabras cortas', () => {
    expect(sharesSurname('Ejemplo García', BUSINESS)).toBe(false);
    expect(sharesSurname('Ana de Paz', 'Bar de Paz')).toBe(true);
    expect(sharesSurname('Ana Li', 'Li Fontanería')).toBe(false);
  });
});

describe('filterDraftReviews', () => {
  it('solo 4 y 5 estrellas con texto, y nunca la de un posible familiar', () => {
    const out = filterDraftReviews(
      [
        review({ name: 'r/1' }),
        review({ name: 'r/2', rating: 3 }),
        review({ name: 'r/3', text: '   ' }),
        review({ name: 'r/4', authorName: 'Rosa Ejemplo' }),
        review({ name: 'r/5', rating: 4, authorName: 'Pedro Luis Vega' }),
      ],
      BUSINESS,
    );
    expect(out.map((r) => r.ref)).toEqual(['r/1', 'r/5']);
    expect(out[0].author).toBe('Andrés M.');
  });
});

describe('resolveHighlights / renderableHighlights', () => {
  const reviews: DraftReview[] = filterDraftReviews(
    [
      review({ name: 'r/1', text: 'Localiza las averías muy rápido y no rompe nada. Muy limpio.' }),
      review({ name: 'r/2', text: 'Puntual, honrado y viene preparado.', authorName: 'Lucía Ramos' }),
    ],
    BUSINESS,
  );

  it('solo sobrevive una cita LITERAL de la reseña que dice citar', () => {
    const stored = resolveHighlights(
      [
        { title: 'Rápido', review: 1, quote: '«Localiza las averías muy rápido»' },
        { title: 'Inventada', review: 2, quote: 'el mejor fontanero de la isla' },
        { title: 'Índice malo', review: 9, quote: 'Puntual, honrado' },
        { title: 'Puntual', review: 2, quote: 'Puntual, honrado y viene preparado' },
      ],
      reviews,
    );
    expect(stored.map((h) => h.title)).toEqual(['Rápido', 'Puntual']);
    expect(stored[0]).toMatchObject({ reviewRef: 'r/1', start: 0, length: 'Localiza las averías muy rápido'.length });
    // Lo guardado no lleva el texto de la reseña.
    expect(JSON.stringify(stored)).not.toContain('averías');
  });

  it('no repite títulos y se queda en cuatro', () => {
    const raw = Array.from({ length: 6 }, (_, i) => ({ title: i < 2 ? 'Mismo' : `T${i}`, review: 2, quote: 'Puntual, honrado' }));
    const stored = resolveHighlights(raw, reviews);
    expect(stored.length).toBeLessThanOrEqual(4);
    expect(stored.filter((h) => h.title === 'Mismo')).toHaveLength(1);
  });

  it('al pintar, la cita sale del texto de hoy y cae si la reseña cambió o ya no está', () => {
    const stored = resolveHighlights([{ title: 'Rápido', review: 1, quote: 'Localiza las averías muy rápido' }], reviews);
    expect(renderableHighlights(stored, reviews)).toEqual([
      { title: 'Rápido', quote: 'Localiza las averías muy rápido', author: 'Andrés M.' },
    ]);
    const edited = reviews.map((r) => (r.ref === 'r/1' ? { ...r, text: 'Ahora dice otra cosa distinta del todo.' } : r));
    expect(renderableHighlights(stored, edited)).toEqual([]);
    expect(renderableHighlights(stored, reviews.slice(1))).toEqual([]);
    expect(renderableHighlights(undefined, reviews)).toEqual([]);
  });

  it('la huella es estable', () => {
    expect(quoteHash('abc')).toBe(quoteHash('abc'));
    expect(quoteHash('abc')).not.toBe(quoteHash('abd'));
  });
});

describe('groupOpeningHours', () => {
  it('agrupa los días seguidos con el mismo horario', () => {
    expect(groupOpeningHours(HOURS_ALL_WEEK)).toEqual([{ days: 'Lunes a domingo', hours: '8:00–20:00' }]);
    const split = [...HOURS_ALL_WEEK.slice(0, 5), 'sábado: 9:00–14:00', 'domingo: Cerrado'];
    expect(groupOpeningHours(split)).toEqual([
      { days: 'Lunes a viernes', hours: '8:00–20:00' },
      { days: 'Sábado', hours: '9:00–14:00' },
      { days: 'Domingo', hours: 'Cerrado' },
    ]);
  });
  it('un horario que no entiende no se pinta: mejor ninguno que uno mal leído', () => {
    expect(groupOpeningHours([])).toEqual([]);
    expect(groupOpeningHours(['Monday: 8:00 AM – 8:00 PM'])).toEqual([]);
  });
  it('la portada solo resume si es el mismo horario los siete días', () => {
    expect(openEveryDaySummary(groupOpeningHours(HOURS_ALL_WEEK))).toBe('Abierto los 7 días, 8:00–20:00');
    expect(openEveryDaySummary(groupOpeningHours([...HOURS_ALL_WEEK.slice(0, 6), 'domingo: Cerrado']))).toBeNull();
  });
});

describe('mapPlaceDraftData', () => {
  it('marca las reseñas traducidas y trata las cadenas vacías como ausentes', () => {
    const data = mapPlaceDraftData({
      formattedAddress: '',
      rating: 5,
      userRatingCount: 17,
      reviews: [
        {
          name: 'r/1',
          rating: 5,
          text: { text: 'Muy bien', languageCode: 'es' },
          originalText: { text: 'Very good', languageCode: 'en' },
          authorAttribution: { displayName: 'John Smith', uri: '' },
        },
        { name: '', rating: 5, text: { text: 'Sin nombre de recurso' } },
      ],
    });
    expect(data.formattedAddress).toBeNull();
    expect(data.reviews).toHaveLength(1);
    expect(data.reviews[0]).toMatchObject({ translated: true, authorUri: null });
    expect(data.weekdayDescriptions).toEqual([]);
  });
});

describe('isLiveEntryFresh', () => {
  it('lo de Google no se enseña con más de una hora', () => {
    expect(isLiveEntryFresh(0, LIVE_CACHE_TTL_MS - 1)).toBe(true);
    expect(isLiveEntryFresh(0, LIVE_CACHE_TTL_MS)).toBe(false);
  });
});

describe('withLiveData — la dirección vieja', () => {
  const base = {
    businessName: BUSINESS,
    primaryType: 'plumber',
    city: 'Las Palmas de Gran Canaria',
    address: addressFromLeadSummary('Negocio encontrado en C. Antigua, 20, 35010 Las Palmas de Gran Canaria, Las Palmas, Spain.'),
    phone: '+34600000000',
    rating: null,
    reviewCount: null,
  };
  const live: PlaceDraftData = {
    formattedAddress: 'C. Nueva, 50, 35010 Las Palmas de Gran Canaria, Las Palmas, España',
    phoneNumber: '+34 600 00 00 00',
    rating: 5,
    userRatingCount: 17,
    weekdayDescriptions: HOURS_ALL_WEEK,
    reviews: [review({ name: 'r/1' })],
    googleMapsUri: 'https://maps.google.com/?cid=1',
    businessStatus: 'OPERATIONAL',
  };

  it('lo guardado sale sin «Spain» y sin el prefijo del barrido', () => {
    expect(base.address).toBe('C. Antigua, 20, 35010 Las Palmas de Gran Canaria, Las Palmas');
  });

  it('lo de Google de hoy gana a lo guardado el día que se encontró al negocio', () => {
    const subject = withLiveData(base, live, { highlights: [] });
    expect(subject.address).toBe('C. Nueva, 50, 35010 Las Palmas de Gran Canaria, Las Palmas');
    expect(subject.rating).toBe(5);
    expect(subject.reviewCount).toBe(17);
    expect(subject.hours).toHaveLength(1);
    expect(subject.reviews).toHaveLength(1);
  });

  it('sin datos en vivo se queda con lo guardado', () => {
    expect(withLiveData(base, null, {})).toEqual(base);
  });
});

describe('parseWebDraftResponse con reseñas', () => {
  const reviews = filterDraftReviews([review({ name: 'r/1' })], BUSINESS);
  it('guarda las citas que son literales y tira las inventadas', () => {
    const copy = parseWebDraftResponse(
      JSON.stringify({
        headline: 'Encuentra la avería sin romper nada',
        highlights: [
          { title: 'Rápido', review: 1, quote: 'Localiza las averías muy rápido' },
          { title: 'Barato', review: 1, quote: 'el precio más barato de la isla' },
        ],
      }),
      reviews,
    );
    expect(copy?.highlights?.map((h) => h.title)).toEqual(['Rápido']);
  });
  it('sin reseñas, ninguna cita', () => {
    const copy = parseWebDraftResponse(JSON.stringify({ headline: 'X', highlights: [{ title: 'A', review: 1, quote: 'algo largo' }] }));
    expect(copy?.highlights).toEqual([]);
  });
});

describe('renderWebDraftHtml — secciones que dependen de Google', () => {
  const copy = parseWebDraftResponse(
    JSON.stringify({
      headline: 'Encuentra la avería sin romper nada',
      services: [{ name: 'Desatascos', description: 'Desagües y bajantes.' }],
      callToAction: 'Llama y cuéntanos',
    }),
  )!;
  const reviews = filterDraftReviews(
    [review({ name: 'r/1' }), review({ name: 'r/2', authorName: 'Lucía Ramos', text: 'Puntual, honrado y viene preparado.' })],
    BUSINESS,
  );
  const full = {
    businessName: BUSINESS,
    primaryType: 'plumber',
    city: 'Las Palmas de Gran Canaria',
    address: 'C. Nueva, 50',
    phone: '+34600000000',
    rating: 5,
    reviewCount: 17,
    hours: groupOpeningHours(HOURS_ALL_WEEK),
    googleMapsUri: 'https://maps.google.com/?cid=1',
    reviews,
    highlights: [
      { title: 'Rápido', quote: 'Localiza las averías muy rápido', author: 'Andrés M.' },
      { title: 'Puntual', quote: 'Puntual, honrado', author: 'Lucía R.' },
    ],
  };

  it('con datos: banda, reseñas con atribución y aviso de filtro, horario y enlace a Google', () => {
    const html = renderWebDraftHtml({ subject: full, copy, generatedAt: new Date('2026-10-26') });
    expect(html).toContain('Lo que repiten sus clientes');
    expect(html).toContain('Andrés M.');
    expect(html).toContain('href="https://www.google.com/maps/contrib/1"');
    expect(html).toContain('Reseñas de Google de 4 y 5 estrellas');
    expect(html).toContain('Ver las 17 reseñas en Google');
    expect(html).toContain('Lunes a domingo');
    expect(html).toContain('Abierto los 7 días');
    expect(html).toContain('5,0');
  });

  it('sin reseñas ni horario: esas secciones no aparecen, y nunca «0 reseñas»', () => {
    const html = renderWebDraftHtml({
      subject: { ...full, rating: null, reviewCount: 0, hours: [], reviews: [], highlights: [], googleMapsUri: null, address: null },
      copy,
      generatedAt: new Date('2026-10-26'),
    });
    expect(html).not.toContain('Lo que repiten');
    expect(html).not.toContain('id="opiniones"');
    expect(html).not.toContain('id="horario"');
    expect(html).not.toMatch(/\b0 reseñas/);
  });

  it('una valoración floja no sale: es una propuesta de venta', () => {
    const html = renderWebDraftHtml({
      subject: { ...full, rating: 3.4, reviews: [], highlights: [] },
      copy,
      generatedAt: new Date('2026-10-26'),
    });
    expect(html).not.toContain('3,4');
    expect(html).not.toContain('reseñas en Google');
  });

  it('una sola cita no hace banda', () => {
    const html = renderWebDraftHtml({
      subject: { ...full, highlights: full.highlights.slice(0, 1) },
      copy,
      generatedAt: new Date('2026-10-26'),
    });
    expect(html).not.toContain('Lo que repiten sus clientes');
  });

  it('el sitio publicado no dice «imagen de muestra» ni «servicios orientativos»', () => {
    const html = renderWebDraftHtml({ subject: full, copy, generatedAt: new Date('2026-10-26') });
    expect(html).toContain('Imagen de muestra');
    expect(html).toContain('Servicios orientativos');
    const site = stripDraftChrome(html);
    expect(site).not.toContain('Imagen de muestra:');
    expect(site).not.toContain('Servicios orientativos');
    expect(site).not.toContain('Propuesta de Kairikos');
  });

  // 26/10/2026 — las políticas de Places piden el logotipo de Google Maps
  // cuando sus datos salen sin mapa; el texto solo vale si falta espacio.
  it('con datos de Places lleva el logotipo de Google Maps, oscuro sobre claro y blanco sobre la noche', () => {
    const html = renderWebDraftHtml({ subject: full, copy, generatedAt: new Date('2026-10-26') });
    expect(html).toContain(GOOGLE_MAPS_LOGO_DARK);
    expect(html).toContain(GOOGLE_MAPS_LOGO_WHITE);
    expect(html).toMatch(/<img src="[^"]+" alt="Google Maps" width="98" height="18" translate="no">/);
    // En la web publicada no hay datos de Places, y la ruta no existiría.
    expect(stripDraftChrome(html)).not.toContain('google-maps-logo');
  });

  it('sin datos de Google no pone el logotipo', () => {
    const html = renderWebDraftHtml({
      subject: { ...full, rating: null, reviewCount: null, reviews: [], highlights: [], hours: [], address: null },
      copy,
      generatedAt: new Date('2026-10-26'),
    });
    expect(html).not.toContain('google-maps-logo');
  });
});
