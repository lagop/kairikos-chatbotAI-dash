// =============================================================================
// A1 — unit tests para src/lib/prospecting-report.ts y la selección de
// competidores de src/lib/prospecting-competitors.ts.
//
// Este informe se enseña a un negocio real por teléfono, así que lo que se
// fija aquí es sobre todo lo que NO debe pasar:
//
// - que un "sin datos" se cuele como 0 y hunda la media de la zona;
// - que un empate a estrellas degrade la posición del prospecto;
// - que un número absurdo escrito en la llamada produzca una cifra
//   indefendible ("pierdes 5 millones al año");
// - que el propio prospecto se cuente como competidor de sí mismo, cosa
//   que pasaría siempre, porque Google lo devuelve en sus propios
//   resultados;
// - que la cifra anual no sea exactamente doce veces la mensual, que es lo
//   primero que multiplica cualquiera que dude del informe.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  buildCompetitorComparison,
  buildReportModel,
  estimateMissedCallValue,
  haversineMeters,
  DEFAULT_MISSED_CALL_ASSUMPTIONS,
  type CompetitorInput,
} from '@/lib/prospecting-report';
import { selectCompetitors, buildCompetitorQuery } from '@/lib/prospecting-competitors';
import type { PlaceSearchResult } from '@/lib/google-places';

function competitor(over: Partial<CompetitorInput> = {}): CompetitorInput {
  return {
    placeId: over.placeId ?? 'place-x',
    name: over.name ?? 'Competidor',
    rating: over.rating === undefined ? 4 : over.rating,
    reviewCount: over.reviewCount === undefined ? 50 : over.reviewCount,
    distanceMeters: over.distanceMeters === undefined ? 400 : over.distanceMeters,
  };
}

describe('buildCompetitorComparison', () => {
  it('sin competidores no inventa una posición', () => {
    const c = buildCompetitorComparison({ name: 'Yo', rating: 4.5, reviewCount: 10 }, []);
    expect(c.comparedCount).toBe(0);
    expect(c.ratingRank).toBeNull();
    expect(c.averageRating).toBeNull();
    expect(c.ratingGap).toBeNull();
  });

  it('descarta a los competidores sin valoración en vez de contarlos como 0', () => {
    const c = buildCompetitorComparison({ name: 'Yo', rating: 4, reviewCount: 10 }, [
      competitor({ placeId: 'a', rating: 5 }),
      competitor({ placeId: 'b', rating: null, reviewCount: null }),
    ]);
    expect(c.comparedCount).toBe(1);
    expect(c.averageRating).toBe(5);
    // Con el null contado como 0 la media sería 2,5 y el informe diría que
    // el prospecto va por delante de su zona. Justo lo contrario.
    expect(c.ratingGap).toBe(-1);
  });

  it('un empate comparte posición, no la empeora', () => {
    const c = buildCompetitorComparison({ name: 'Yo', rating: 4.5, reviewCount: 10 }, [
      competitor({ placeId: 'a', rating: 4.5 }),
      competitor({ placeId: 'b', rating: 4.5 }),
      competitor({ placeId: 'c', rating: 4.9 }),
    ]);
    expect(c.ratingRank).toBe(2);
    expect(c.rankedCount).toBe(4);
  });

  it('el prospecto sin valoración no entra en el ranking', () => {
    const c = buildCompetitorComparison({ name: 'Yo', rating: null, reviewCount: null }, [
      competitor({ placeId: 'a', rating: 4.5 }),
    ]);
    expect(c.ratingRank).toBeNull();
    expect(c.rankedCount).toBe(1);
  });

  it('el líder de reseñas es el que más tiene, con su nombre', () => {
    const c = buildCompetitorComparison({ name: 'Yo', rating: 4, reviewCount: 12 }, [
      competitor({ placeId: 'a', name: 'Los del barrio', reviewCount: 80 }),
      competitor({ placeId: 'b', name: 'Otros', reviewCount: 30 }),
    ]);
    expect(c.reviewLeaderName).toBe('Los del barrio');
    expect(c.reviewGapToTop).toBe(68);
  });

  it('quien ya lidera en reseñas tiene distancia 0, nunca negativa', () => {
    const c = buildCompetitorComparison({ name: 'Yo', rating: 4, reviewCount: 200 }, [
      competitor({ placeId: 'a', reviewCount: 80 }),
    ]);
    expect(c.reviewGapToTop).toBe(0);
  });
});

describe('estimateMissedCallValue', () => {
  it('usa supuestos conservadores por defecto', () => {
    const e = estimateMissedCallValue();
    expect(e.assumptions).toEqual(DEFAULT_MISSED_CALL_ASSUMPTIONS);
    expect(e.monthlyLostRevenue).toBeGreaterThan(0);
  });

  it('la cifra anual es exactamente doce veces la mensual', () => {
    const e = estimateMissedCallValue({ missedCallsPerWeek: 7, averageJobValue: 437, closeRate: 0.41 });
    expect(e.annualLostRevenue).toBe(e.monthlyLostRevenue * 12);
  });

  it('recorta valores absurdos en vez de producir una cifra indefendible', () => {
    const e = estimateMissedCallValue({ missedCallsPerWeek: 99999, averageJobValue: -5, closeRate: 7 });
    expect(e.assumptions.missedCallsPerWeek).toBe(100);
    expect(e.assumptions.averageJobValue).toBe(0);
    expect(e.assumptions.closeRate).toBe(1);
    expect(e.monthlyLostRevenue).toBe(0);
  });

  it('ignora entradas que no son números', () => {
    const e = estimateMissedCallValue({ missedCallsPerWeek: Number.NaN, closeRate: undefined });
    expect(e.assumptions.missedCallsPerWeek).toBe(DEFAULT_MISSED_CALL_ASSUMPTIONS.missedCallsPerWeek);
    expect(e.assumptions.closeRate).toBe(DEFAULT_MISSED_CALL_ASSUMPTIONS.closeRate);
  });
});

describe('buildReportModel — hallazgos', () => {
  const subject = {
    name: 'Fontanería Ejemplo',
    address: 'Calle Falsa 1',
    phone: '+34600000000',
    website: null,
    category: 'fontanero',
    location: 'Elche',
    rating: null as number | null,
    reviewCount: null as number | null,
  };

  it('un negocio sin reseñas se dice tal cual, sin hablar de distancias', () => {
    const m = buildReportModel({ subject, competitors: [competitor()], capturedAt: new Date('2026-09-22') });
    expect(m.findings.map((f) => f.kind)).toContain('no_reviews');
    expect(m.findings.map((f) => f.kind)).not.toContain('reviews_behind');
  });

  it('al que va por delante también se le dice, no solo malas noticias', () => {
    const m = buildReportModel({
      subject: { ...subject, rating: 4.9, reviewCount: 120 },
      competitors: [competitor({ rating: 4.0, reviewCount: 30 })],
      capturedAt: new Date('2026-09-22'),
    });
    expect(m.findings.map((f) => f.kind)).toContain('rating_ahead');
  });

  it('sin competidores válidos no se afirma nada sobre la zona', () => {
    const m = buildReportModel({
      subject: { ...subject, rating: 4.2, reviewCount: 8 },
      competitors: [],
      capturedAt: new Date('2026-09-22'),
    });
    const kinds = m.findings.map((f) => f.kind);
    expect(kinds).not.toContain('rating_behind');
    expect(kinds).not.toContain('rating_ahead');
  });
});

describe('selectCompetitors', () => {
  function place(over: Partial<PlaceSearchResult> = {}): PlaceSearchResult {
    return {
      id: over.id ?? 'p1',
      name: over.name ?? 'Negocio',
      formattedAddress: null,
      websiteUri: null,
      types: [],
      latitude: over.latitude === undefined ? 38.27 : over.latitude,
      longitude: over.longitude === undefined ? -0.7 : over.longitude,
      rating: over.rating === undefined ? 4.1 : over.rating,
      userRatingCount: over.userRatingCount === undefined ? 20 : over.userRatingCount,
    };
  }

  const subject = {
    leadId: 'lead-1',
    clientId: 'client-1',
    tenantId: null,
    placeId: 'me',
    name: 'Fontanería Ejemplo',
    latitude: 38.2699,
    longitude: -0.7126,
    primaryType: 'plumber',
    searchCategory: 'fontanero',
    searchLocation: 'Elche',
  };

  it('excluye al propio prospecto de sus competidores', () => {
    const rows = selectCompetitors([place({ id: 'me' }), place({ id: 'otro' })], subject);
    expect(rows.map((r) => r.placeId)).toEqual(['otro']);
  });

  it('descarta resultados sin valoración: no aportan a una comparativa', () => {
    const rows = selectCompetitors([place({ id: 'a', rating: null }), place({ id: 'b' })], subject);
    expect(rows.map((r) => r.placeId)).toEqual(['b']);
  });

  it('ordena por cercanía y recorta al tope', () => {
    const rows = selectCompetitors(
      [
        place({ id: 'lejos', latitude: 38.4, longitude: -0.9 }),
        place({ id: 'cerca', latitude: 38.2701, longitude: -0.7128 }),
        place({ id: 'medio', latitude: 38.28, longitude: -0.72 }),
        place({ id: 'lejisimos', latitude: 39, longitude: -1 }),
      ],
      subject,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].placeId).toBe('cerca');
  });

  it('sin coordenadas del prospecto ordena por reseñas y deja la distancia en null', () => {
    const rows = selectCompetitors(
      [place({ id: 'a', userRatingCount: 10 }), place({ id: 'b', userRatingCount: 300 })],
      { ...subject, latitude: null, longitude: null },
    );
    expect(rows[0].placeId).toBe('b');
    expect(rows[0].distanceMeters).toBeNull();
  });
});

describe('buildCompetitorQuery', () => {
  const base = {
    leadId: 'l',
    clientId: 'c',
    tenantId: null,
    placeId: 'p',
    name: 'N',
    latitude: null,
    longitude: null,
    primaryType: null as string | null,
    searchCategory: null as string | null,
    searchLocation: null as string | null,
  };

  it('prefiere el tipo de Google y lo convierte en texto buscable', () => {
    expect(buildCompetitorQuery({ ...base, primaryType: 'hair_salon', searchLocation: 'Elche' })).toBe(
      'hair salon en Elche',
    );
  });

  it('cae al rubro del cliente cuando Google no dio tipo', () => {
    expect(buildCompetitorQuery({ ...base, searchCategory: 'fontanero', searchLocation: 'Elche' })).toBe(
      'fontanero en Elche',
    );
  });

  it('sin rubro de ningún tipo no hay búsqueda posible', () => {
    expect(buildCompetitorQuery(base)).toBeNull();
  });
});

describe('haversineMeters', () => {
  it('el mismo punto son 0 metros', () => {
    expect(haversineMeters({ latitude: 38.27, longitude: -0.7 }, { latitude: 38.27, longitude: -0.7 })).toBe(0);
  });

  it('una distancia conocida cae en el orden de magnitud correcto', () => {
    // Elche → Alicante, unos 20 km en línea recta.
    const d = haversineMeters({ latitude: 38.2699, longitude: -0.7126 }, { latitude: 38.3452, longitude: -0.481 });
    expect(d).toBeGreaterThan(18000);
    expect(d).toBeLessThan(24000);
  });
});
