// =============================================================================
// Fase 3.1 — unit tests para src/lib/seo-keywords.ts.
//
// Dos cosas se rompen fácil aquí y por eso llevan test propio: la
// normalización (si no casa con lo que devuelve Search Console, el
// seguimiento no encuentra NADA nunca) y el signo del cambio (mejorar en
// SEO es bajar de número, y enseñar "-6" para una mejora se lee al revés).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeKeyword,
  toUtcDate,
  snapshotKeywordPositions,
  buildKeywordTrends,
  MAX_TARGET_KEYWORDS,
} from '@/lib/seo-keywords';

const NOW = new Date('2026-09-15T09:30:00Z');

const state = {
  keywordFindMany: vi.fn(),
  positionUpsert: vi.fn(),
};

const prismaMock = {
  seoTargetKeyword: { findMany: (...a: unknown[]) => state.keywordFindMany(...a) },
  seoKeywordPosition: { upsert: (...a: unknown[]) => state.positionUpsert(...a) },
} as unknown as Parameters<typeof snapshotKeywordPositions>[0];

beforeEach(() => {
  state.keywordFindMany.mockReset().mockResolvedValue([]);
  state.positionUpsert.mockReset().mockResolvedValue({});
});

describe('normalizeKeyword', () => {
  it('casa con la forma en que Search Console devuelve las consultas', () => {
    expect(normalizeKeyword('  Mechas Babylights  ')).toBe('mechas babylights');
    expect(normalizeKeyword('CORTE   de   pelo')).toBe('corte de pelo');
  });

  it('deja igual lo que ya está normalizado', () => {
    expect(normalizeKeyword('mechas babylights')).toBe('mechas babylights');
  });
});

describe('toUtcDate', () => {
  it('se queda con el día UTC, sin hora', () => {
    expect(toUtcDate(NOW).toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });
});

describe('snapshotKeywordPositions', () => {
  it('no toca nada si el cliente no persigue ninguna palabra', async () => {
    const result = await snapshotKeywordPositions(prismaMock, 'c1', [
      { query: 'lo que sea', position: 3, clicks: 1, impressions: 10 },
    ], NOW);
    expect(result).toEqual({ tracked: 0, ranking: 0 });
    expect(state.positionUpsert).not.toHaveBeenCalled();
  });

  it('archiva la posición del día para cada palabra que hoy aparece', async () => {
    state.keywordFindMany.mockResolvedValue([{ id: 'k1', keyword: 'mechas babylights' }]);

    const result = await snapshotKeywordPositions(prismaMock, 'c1', [
      { query: 'Mechas Babylights', position: 11.42, clicks: 3, impressions: 120 },
    ], NOW);

    expect(result).toEqual({ tracked: 1, ranking: 1 });
    expect(state.positionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { targetKeywordId_date: { targetKeywordId: 'k1', date: toUtcDate(NOW) } },
        create: expect.objectContaining({ position: 11.42, clicks: 3, impressions: 120 }),
      }),
    );
  });

  it('una palabra que hoy no aparece se guarda con posición nula, no se omite', async () => {
    state.keywordFindMany.mockResolvedValue([{ id: 'k1', keyword: 'no salgo por esto' }]);

    const result = await snapshotKeywordPositions(prismaMock, 'c1', [], NOW);

    expect(result).toEqual({ tracked: 1, ranking: 0 });
    expect(state.positionUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ position: null, clicks: 0, impressions: 0 }) }),
    );
  });

  it('es idempotente por día: dos sincronizaciones actualizan el mismo punto', async () => {
    state.keywordFindMany.mockResolvedValue([{ id: 'k1', keyword: 'mechas' }]);
    await snapshotKeywordPositions(prismaMock, 'c1', [{ query: 'mechas', position: 9, clicks: 1, impressions: 5 }], NOW);
    const call = state.positionUpsert.mock.calls[0][0];
    expect(call.update).toEqual({ position: 9, clicks: 1, impressions: 5 });
  });

  it('el tope de palabras es una decisión de producto, no un número suelto', () => {
    expect(MAX_TARGET_KEYWORDS).toBe(20);
  });
});

describe('buildKeywordTrends', () => {
  const trendPrisma = (targets: unknown[]) =>
    ({
      seoTargetKeyword: { findMany: vi.fn().mockResolvedValue(targets) },
    }) as unknown as Parameters<typeof buildKeywordTrends>[0];

  function point(date: string, position: number | null, clicks = 0, impressions = 0) {
    return { date: new Date(`${date}T00:00:00Z`), position, clicks, impressions };
  }

  it('cuenta como mejora haber BAJADO de número', async () => {
    const trends = await buildKeywordTrends(
      trendPrisma([{ id: 'k1', keyword: 'mechas', positions: [point('2026-08-20', 14), point('2026-09-14', 8, 5, 90)] }]),
      'c1',
      NOW,
    );
    expect(trends[0]).toMatchObject({ position: 8, previousPosition: 14, change: 6, clicks: 5 });
  });

  it('una caída sale en negativo', async () => {
    const trends = await buildKeywordTrends(
      trendPrisma([{ id: 'k1', keyword: 'x', positions: [point('2026-08-20', 5), point('2026-09-14', 12)] }]),
      'c1',
      NOW,
    );
    expect(trends[0].change).toBe(-7);
  });

  it('con un solo punto no hay comparación que hacer', async () => {
    const trends = await buildKeywordTrends(
      trendPrisma([{ id: 'k1', keyword: 'x', positions: [point('2026-09-14', 8)] }]),
      'c1',
      NOW,
    );
    expect(trends[0]).toMatchObject({ position: 8, change: null });
  });

  it('ignora los días sin posición al comparar, pero los conserva en la serie', async () => {
    const trends = await buildKeywordTrends(
      trendPrisma([{
        id: 'k1', keyword: 'x',
        positions: [point('2026-09-01', null), point('2026-09-05', 20), point('2026-09-10', null), point('2026-09-14', 10)],
      }]),
      'c1',
      NOW,
    );
    expect(trends[0]).toMatchObject({ position: 10, previousPosition: 20, change: 10 });
    expect(trends[0].history).toHaveLength(4);
    expect(trends[0].history[0]).toEqual({ date: '2026-09-01', position: null });
  });

  it('una palabra que nunca ha aparecido no finge una posición', async () => {
    const trends = await buildKeywordTrends(
      trendPrisma([{ id: 'k1', keyword: 'x', positions: [point('2026-09-14', null)] }]),
      'c1',
      NOW,
    );
    expect(trends[0]).toMatchObject({ position: null, previousPosition: null, change: null });
  });
});
