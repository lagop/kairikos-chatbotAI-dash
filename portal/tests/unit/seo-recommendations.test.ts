// =============================================================================
// Fase 3.2 — unit tests para src/lib/seo-recommendations.ts.
//
// Todo puro, así que aquí se fija lo que de verdad importa: que lo urgente
// salga primero, que no se invente problemas donde no los hay, y que un
// audit viejo o corrupto no tumbe la página del cliente.
// =============================================================================

import { describe, it, expect } from 'vitest';
import type { SeoAuditResult } from '@/lib/seo-audit';
import { buildRecommendations, countBySeverity, parseAuditResult } from '@/lib/seo-recommendations';

function audit(over: Partial<SeoAuditResult> = {}): SeoAuditResult {
  return {
    // Una web sana por defecto: cada test rompe solo lo que quiere probar.
    title: 'Peluquería Aurora — coloración y mechas en Las Palmas',
    metaDescription:
      'Peluquería de barrio en Las Palmas especializada en coloración, mechas y tratamientos capilares. Pide tu cita hoy mismo.',
    h1Count: 1,
    h1Texts: ['Peluquería Aurora'],
    imagesTotal: 10,
    imagesMissingAlt: 0,
    linksInternal: 12,
    linksExternal: 3,
    brokenLinksChecked: 15,
    brokenLinks: [],
    checkedAt: '2026-09-07T10:00:00.000Z',
    ...over,
  };
}

describe('buildRecommendations — una web sin problemas', () => {
  it('no inventa nada que arreglar', () => {
    expect(buildRecommendations(audit())).toEqual([]);
  });
});

describe('buildRecommendations — título', () => {
  it('marca como prioritario que falte', () => {
    const recs = buildRecommendations(audit({ title: null }));
    expect(recs[0]).toMatchObject({ id: 'title-missing', severity: 'alta', autoApplicable: true });
  });

  it('trata un título vacío igual que uno ausente', () => {
    expect(buildRecommendations(audit({ title: '   ' }))[0].id).toBe('title-missing');
  });

  it('avisa si se queda corto, diciendo cuánto mide', () => {
    const rec = buildRecommendations(audit({ title: 'Peluquería' }))[0];
    expect(rec.id).toBe('title-short');
    expect(rec.title).toContain('10 caracteres');
  });

  it('un título largo es mejora menor, no urgencia', () => {
    const rec = buildRecommendations(audit({ title: 'x'.repeat(80) }))[0];
    expect(rec).toMatchObject({ id: 'title-long', severity: 'baja' });
  });
});

describe('buildRecommendations — el resto de señales', () => {
  it('la meta description ausente es prioritaria', () => {
    expect(buildRecommendations(audit({ metaDescription: null })).map((r) => r.id)).toContain('meta-missing');
  });

  it('distingue no tener encabezado principal de tener varios', () => {
    expect(buildRecommendations(audit({ h1Count: 0 }))[0]).toMatchObject({ id: 'h1-missing', severity: 'alta' });
    expect(buildRecommendations(audit({ h1Count: 3 }))[0]).toMatchObject({ id: 'h1-multiple', severity: 'baja' });
  });

  it('sube la severidad de las imágenes cuando falta la descripción en la mitad o más', () => {
    expect(buildRecommendations(audit({ imagesTotal: 10, imagesMissingAlt: 1 }))[0].severity).toBe('baja');
    expect(buildRecommendations(audit({ imagesTotal: 10, imagesMissingAlt: 7 }))[0].severity).toBe('media');
  });

  it('nombra los enlaces rotos, sin listarlos todos', () => {
    const rec = buildRecommendations(
      audit({
        brokenLinks: [
          { url: '/a', status: 404 }, { url: '/b', status: 404 },
          { url: '/c', status: 404 }, { url: '/d', status: 500 },
        ],
      }),
    )[0];
    expect(rec).toMatchObject({ id: 'broken-links', severity: 'alta' });
    expect(rec.title).toContain('4 enlaces rotos');
    expect(rec.detail).toContain('/a');
    expect(rec.detail).not.toContain('/d');
    expect(rec.detail).toContain('…');
  });

  it('avisa de una página sin enlaces internos', () => {
    expect(buildRecommendations(audit({ linksInternal: 0 })).map((r) => r.id)).toContain('internal-links');
  });
});

describe('buildRecommendations — orden y resumen', () => {
  it('lo prioritario va primero', () => {
    const recs = buildRecommendations(
      audit({ title: 'x'.repeat(80), metaDescription: null, imagesMissingAlt: 2, brokenLinks: [{ url: '/x', status: 404 }] }),
    );
    expect(recs.map((r) => r.severity)).toEqual([...recs.map((r) => r.severity)].sort((a, b) =>
      ({ alta: 0, media: 1, baja: 2 })[a] - ({ alta: 0, media: 1, baja: 2 })[b],
    ));
    expect(recs[0].severity).toBe('alta');
  });

  it('cuenta por severidad para el resumen', () => {
    const recs = buildRecommendations(audit({ title: null, metaDescription: null, h1Count: 3 }));
    expect(countBySeverity(recs)).toMatchObject({ alta: 2, baja: 1 });
  });

  it('marca qué se podría aplicar solo por WordPress y qué no', () => {
    const recs = buildRecommendations(audit({ title: null, h1Count: 0 }));
    expect(recs.find((r) => r.id === 'title-missing')!.autoApplicable).toBe(true);
    // Tocar los encabezados es reescribir la página: eso no lo hace nadie solo.
    expect(recs.find((r) => r.id === 'h1-missing')!.autoApplicable).toBe(false);
  });
});

describe('parseAuditResult — el audit guardado es un Json libre', () => {
  it('acepta un resultado completo', () => {
    expect(parseAuditResult(audit())).toMatchObject({ h1Count: 1, imagesMissingAlt: 0 });
  });

  it('rechaza lo que no tiene forma de audit, en vez de reventar', () => {
    expect(parseAuditResult(null)).toBeNull();
    expect(parseAuditResult('vaya')).toBeNull();
    expect(parseAuditResult([])).toBeNull();
    expect(parseAuditResult({ title: 'x' })).toBeNull();
  });

  it('rellena con valores neutros los campos que falten de una versión antigua', () => {
    const parsed = parseAuditResult({ h1Count: 1, imagesMissingAlt: 0 })!;
    expect(parsed).toMatchObject({ title: null, imagesTotal: 0, brokenLinks: [], h1Texts: [] });
    // Y con eso ya se puede recomendar sin que explote nada.
    expect(() => buildRecommendations(parsed)).not.toThrow();
  });

  it('descarta entradas basura dentro de brokenLinks', () => {
    const parsed = parseAuditResult({
      h1Count: 1, imagesMissingAlt: 0, brokenLinks: [{ url: '/ok', status: 404 }, null, { status: 500 }],
    })!;
    expect(parsed.brokenLinks).toEqual([{ url: '/ok', status: 404 }]);
  });
});
