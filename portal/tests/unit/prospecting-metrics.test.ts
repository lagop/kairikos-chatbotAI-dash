// =============================================================================
// Fase 3.4 — unit tests para src/lib/prospecting-metrics.ts.
//
// Todo puro. Lo que se fija: que una tasa sin denominador salga null y no
// 0 (enseñar "0 % de respuesta" a quien no ha contactado a nadie es
// mentirle), que el denominador sean los contactados y no los encontrados,
// y que el desglose agrupe por la búsqueda que encontró a cada prospecto y
// no por la que la campaña tenga configurada hoy.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  summarizeProspecting,
  MAX_BREAKDOWN_ROWS,
  UNATTRIBUTED_LABEL,
  type ProspectingLeadRow,
} from '@/lib/prospecting-metrics';

const D = (iso: string) => new Date(iso);

function row(over: Partial<ProspectingLeadRow> = {}): ProspectingLeadRow {
  return {
    status: 'nuevo',
    contactedAt: null,
    repliedAt: null,
    followUpCount: 0,
    searchCategory: 'peluquería',
    searchLocation: 'Las Palmas',
    ...over,
  };
}

describe('summarizeProspecting — recuentos', () => {
  it('sin prospectos no hay nada que resumir', () => {
    const m = summarizeProspecting([]);
    expect(m).toMatchObject({ found: 0, contacted: 0, replied: 0, responseRate: null, conversionRate: null });
    expect(m.byCategory.rows).toEqual([]);
  });

  it('cuenta cada estado por separado', () => {
    const m = summarizeProspecting([
      row(),
      row({ status: 'contactado', contactedAt: D('2026-09-01') }),
      row({ status: 'convertido', contactedAt: D('2026-09-01'), repliedAt: D('2026-09-02') }),
      row({ status: 'descartado', contactedAt: D('2026-09-01') }),
    ]);
    expect(m).toMatchObject({ found: 4, contacted: 3, replied: 1, converted: 1, discarded: 1 });
  });
});

describe('summarizeProspecting — tasas', () => {
  it('la tasa de respuesta se calcula sobre los contactados, no sobre los encontrados', () => {
    // 10 encontrados, 2 contactados, 1 responde: 50 %, no 10 %.
    const rows = [
      ...Array.from({ length: 8 }, () => row()),
      row({ status: 'contactado', contactedAt: D('2026-09-01'), repliedAt: D('2026-09-02') }),
      row({ status: 'contactado', contactedAt: D('2026-09-01') }),
    ];
    expect(summarizeProspecting(rows).responseRate).toBe(0.5);
  });

  it('sin nadie contactado la tasa es null, nunca 0', () => {
    const m = summarizeProspecting([row(), row()]);
    expect(m.responseRate).toBeNull();
    expect(m.conversionRate).toBeNull();
  });

  it('contactados sin ninguna respuesta sí es un 0 legítimo', () => {
    const m = summarizeProspecting([row({ status: 'contactado', contactedAt: D('2026-09-01') })]);
    expect(m.responseRate).toBe(0);
  });

  it('la conversión también se mide sobre los contactados', () => {
    const m = summarizeProspecting([
      row({ status: 'convertido', contactedAt: D('2026-09-01') }),
      row({ status: 'contactado', contactedAt: D('2026-09-01') }),
      row(),
    ]);
    expect(m.conversionRate).toBe(0.5);
  });
});

describe('summarizeProspecting — secuencia agotada', () => {
  it('cuenta a quien recibió los tres toques y nunca contestó', () => {
    const m = summarizeProspecting([
      row({ status: 'contactado', contactedAt: D('2026-09-01'), followUpCount: 3 }),
      // Contestó: no está agotado, está atendido.
      row({ status: 'contactado', contactedAt: D('2026-09-01'), followUpCount: 3, repliedAt: D('2026-09-05') }),
      // Le queda un toque.
      row({ status: 'contactado', contactedAt: D('2026-09-01'), followUpCount: 2 }),
    ]);
    expect(m.sequenceExhausted).toBe(1);
  });
});

describe('summarizeProspecting — desglose', () => {
  it('agrupa por la búsqueda que encontró a cada prospecto', () => {
    const m = summarizeProspecting([
      row({ searchLocation: 'Las Palmas', status: 'contactado', contactedAt: D('2026-09-01'), repliedAt: D('2026-09-02') }),
      row({ searchLocation: 'Las Palmas', status: 'contactado', contactedAt: D('2026-09-01') }),
      row({ searchLocation: 'Telde', status: 'contactado', contactedAt: D('2026-09-01') }),
    ]);
    expect(m.byLocation.rows).toEqual([
      { label: 'Las Palmas', found: 2, contacted: 2, replied: 1, converted: 0, responseRate: 0.5 },
      { label: 'Telde', found: 1, contacted: 1, replied: 0, converted: 0, responseRate: 0 },
    ]);
  });

  it('ordena por volumen: el grupo con más evidencia primero', () => {
    const m = summarizeProspecting([
      row({ searchCategory: 'ferretería' }),
      row({ searchCategory: 'peluquería' }),
      row({ searchCategory: 'peluquería' }),
    ]);
    expect(m.byCategory.rows.map((r) => r.label)).toEqual(['peluquería', 'ferretería']);
  });

  it('los prospectos anteriores a esta fase se agrupan aparte, dicho como tal', () => {
    const m = summarizeProspecting([row({ searchCategory: null }), row({ searchCategory: '   ' })]);
    expect(m.byCategory.rows).toHaveLength(1);
    expect(m.byCategory.rows[0]).toMatchObject({ label: UNATTRIBUTED_LABEL, found: 2 });
  });

  it('una tasa de grupo sin contactados también es null', () => {
    const m = summarizeProspecting([row({ searchCategory: 'peluquería' })]);
    expect(m.byCategory.rows[0].responseRate).toBeNull();
  });

  it('recorta el desglose y dice cuántos grupos quedan fuera, en vez de esconderlos', () => {
    const rows = Array.from({ length: MAX_BREAKDOWN_ROWS + 3 }, (_, i) => row({ searchLocation: `zona-${i}` }));
    const m = summarizeProspecting(rows);
    expect(m.byLocation.rows).toHaveLength(MAX_BREAKDOWN_ROWS);
    expect(m.byLocation.hiddenGroups).toBe(3);
  });
});
