// =============================================================================
// Fase 2.1 — unit tests para src/lib/review-reputation.ts.
//
// summarizeReviews es puro, así que aquí se prueban los bordes que en
// producción tardarían meses en aparecer: meses sin reseñas, cambio de año,
// un cliente recién conectado y la diferencia entre "sin responder" y
// "respondido con una cadena vacía".
// =============================================================================

import { describe, it, expect } from 'vitest';
import { summarizeReviews, REPUTATION_MONTHS } from '@/lib/review-reputation';

const NOW = new Date('2026-09-15T12:00:00Z');

function review(over: { stars?: number; daysAgo?: number; reply?: string | null } = {}) {
  return {
    starRating: over.stars ?? 5,
    createTime: new Date(NOW.getTime() - (over.daysAgo ?? 1) * 24 * 60 * 60_000),
    replyComment: over.reply === undefined ? null : over.reply,
  };
}

describe('summarizeReviews — cliente sin reseñas', () => {
  it('no inventa medias ni porcentajes', () => {
    const s = summarizeReviews([], NOW);
    expect(s.totalReviews).toBe(0);
    expect(s.averageRating).toBeNull();
    expect(s.responseRate).toBeNull();
    expect(s.averageLast90).toBeNull();
  });

  it('devuelve igualmente los meses, para que el panel no cambie de forma', () => {
    expect(summarizeReviews([], NOW).months).toHaveLength(REPUTATION_MONTHS);
  });
});

describe('summarizeReviews — medias', () => {
  it('redondea a un decimal, como se lee una valoración de Google', () => {
    const s = summarizeReviews([review({ stars: 5 }), review({ stars: 4 }), review({ stars: 4 })], NOW);
    expect(s.averageRating).toBe(4.3);
  });

  it('la media de 90 días ignora lo anterior', () => {
    const s = summarizeReviews([review({ stars: 5, daysAgo: 10 }), review({ stars: 1, daysAgo: 200 })], NOW);
    expect(s.averageRating).toBe(3);
    expect(s.averageLast90).toBe(5);
  });

  it('cuenta las reseñas de los últimos 30 días', () => {
    const s = summarizeReviews([review({ daysAgo: 5 }), review({ daysAgo: 20 }), review({ daysAgo: 45 })], NOW);
    expect(s.reviewsLast30).toBe(2);
  });
});

describe('summarizeReviews — respuestas', () => {
  it('cuenta como respondida solo la que tiene texto de verdad', () => {
    const s = summarizeReviews(
      [review({ reply: 'Gracias!' }), review({ reply: '   ' }), review({ reply: null })],
      NOW,
    );
    expect(s.responseRate).toBeCloseTo(1 / 3);
  });

  it('cuenta las negativas sin responder, que son las urgentes', () => {
    const s = summarizeReviews(
      [
        review({ stars: 1, reply: null }),
        review({ stars: 2, reply: 'Lo sentimos' }),
        review({ stars: 3, reply: null }),
      ],
      NOW,
    );
    expect(s.unansweredNegative).toBe(1);
  });
});

describe('summarizeReviews — evolución mensual', () => {
  it('devuelve los meses del más antiguo al más reciente, terminando en el actual', () => {
    const months = summarizeReviews([], NOW).months.map((m) => m.month);
    expect(months).toHaveLength(6);
    expect(months.at(-1)).toBe('2026-09');
    expect(months[0]).toBe('2026-04');
  });

  it('cruza el cambio de año sin romperse', () => {
    const months = summarizeReviews([], new Date('2026-02-10T00:00:00Z')).months.map((m) => m.month);
    expect(months).toEqual(['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('un mes sin reseñas aparece vacío, no se salta', () => {
    // Solo una reseña, este mes.
    const s = summarizeReviews([review({ daysAgo: 2, stars: 4 })], NOW);
    const current = s.months.at(-1)!;
    const previous = s.months.at(-2)!;
    expect(current).toMatchObject({ reviews: 1, average: 4 });
    expect(previous).toMatchObject({ reviews: 0, average: null });
  });

  it('agrupa por mes natural, no por ventana de 30 días', () => {
    const s = summarizeReviews(
      [
        { starRating: 5, createTime: new Date('2026-08-31T23:00:00Z'), replyComment: null },
        { starRating: 1, createTime: new Date('2026-09-01T01:00:00Z'), replyComment: null },
      ],
      NOW,
    );
    expect(s.months.find((m) => m.month === '2026-08')).toMatchObject({ reviews: 1, average: 5 });
    expect(s.months.find((m) => m.month === '2026-09')).toMatchObject({ reviews: 1, average: 1 });
  });
});
