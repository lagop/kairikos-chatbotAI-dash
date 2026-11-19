// =============================================================================
// Cartera — las reglas de una casa al guardarla (lib/cartera/home-rules.ts):
// referencia, direcciones, historial de precios, validación con las reglas de
// la web, transiciones de estado y borrado. Puras: sin base de datos.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  EDITABLE_KEYS,
  HOME_STATUSES,
  buildSlugs,
  canDeleteHome,
  computeHomeSave,
  initialHomeData,
  madridToday,
  nextPriceHistory,
  nextRef,
  sanitizeHomeData,
  slugify,
  validateHome,
  type HomeBefore,
} from '@/lib/cartera/home-rules';
import { parseMediaLink } from '@/lib/cartera/media-link';
import { ALQUILER_INCLUDES, ALQUILER_TERMS, ALQUILER_TYPES, ENERGY_LETTERS, VENTA_TAGS, VENTA_TYPES, ZONES } from '@/lib/cartera/form-options';
import { alquilerFeedSchema, ventaFeedSchema } from '@/lib/cartera/schema';
import { fullAlquiler, fullVenta } from '../fixtures/cartera/full-homes';

const SITE = { agents: [{ key: 'lucia' }, { key: 'elena' }] };
const NOW = new Date('2026-11-19T10:00:00Z');

/** Como la deja computeHomeSave: con sus direcciones. */
const withSlugs = (data: Record<string, unknown>, ref = 'C-101') => ({ ...data, slugs: buildSlugs(data.title as never, ref) });

function draft(operation: 'venta' | 'alquiler', over: Partial<HomeBefore> = {}): HomeBefore {
  return {
    ref: operation === 'venta' ? 'C-101' : 'A-201',
    operation,
    status: 'borrador',
    data: initialHomeData(operation, SITE, NOW),
    errors: null,
    slugLocked: false,
    firstPublishedAt: null,
    ...over,
  };
}

describe('referencia', () => {
  it('empieza en C-101 / A-201 y sigue a la más alta', () => {
    expect(nextRef([], 'C', 'venta')).toBe('C-101');
    expect(nextRef([], 'A', 'alquiler')).toBe('A-201');
    expect(nextRef(['C-101', 'C-117', 'C-103'], 'C', 'venta')).toBe('C-118');
    // Otras letras o formatos no cuentan.
    expect(nextRef(['P-950', 'C-1x', 'X-500'], 'C', 'venta')).toBe('C-101');
  });

  it('nunca pasa de tres cifras: devuelve null antes de inventar un formato', () => {
    expect(nextRef(['C-998'], 'C', 'venta')).toBe('C-999');
    expect(nextRef(['C-999'], 'C', 'venta')).toBeNull();
  });

  it('la referencia nunca se acepta del cuerpo', () => {
    expect(EDITABLE_KEYS.venta).not.toContain('ref');
    expect(EDITABLE_KEYS.venta).not.toContain('status');
    expect(EDITABLE_KEYS.venta).not.toContain('photos');
    expect(EDITABLE_KEYS.venta).not.toContain('slugs');
    expect(EDITABLE_KEYS.venta).not.toContain('priceHistory');
    expect(EDITABLE_KEYS.alquiler).not.toContain('ref');
    const r = computeHomeSave(draft('venta'), { data: { ...fullVenta(), ref: 'C-999', slugs: { es: 'x', en: 'x', de: 'x' }, photos: [{}] } }, SITE, NOW);
    expect(r.ok && r.data.ref).toBeFalsy();
    expect(r.ok && r.data.photos).toBeFalsy();
    expect(r.ok && (r.data.slugs as { es: string }).es).toBe('villa-con-vistas-al-mar-c-101');
  });
});

describe('direcciones de la ficha', () => {
  it('slugify quita acentos y pasa las diéresis alemanas a ae/oe/ue/ss', () => {
    expect(slugify('Ático en Nerja, ¡vistas!')).toBe('atico-en-nerja-vistas');
    expect(slugify('Wohnung mit Südterrasse und Größe')).toBe('wohnung-mit-suedterrasse-und-groesse');
    expect(slugify('a'.repeat(30) + ' ' + 'b'.repeat(60)).length).toBeLessThanOrEqual(70);
  });

  it('cada idioma de su título, con la referencia al final; sin título, del español o solo la referencia', () => {
    expect(buildSlugs({ es: 'Casa blanca', en: 'White house', de: '' }, 'C-101')).toEqual({ es: 'casa-blanca-c-101', en: 'white-house-c-101', de: 'casa-blanca-c-101' });
    expect(buildSlugs(undefined, 'A-201')).toEqual({ es: 'a-201', en: 'a-201', de: 'a-201' });
  });

  it('salen del título mientras no se publica y se congelan al publicarse', () => {
    const first = computeHomeSave(draft('venta'), { data: fullVenta() }, SITE, NOW);
    expect(first.ok && first.slugLocked).toBe(false);

    const published = computeHomeSave(draft('venta'), { status: 'venta', data: fullVenta() }, SITE, NOW);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.slugLocked).toBe(true);
    expect(published.firstPublishedAt).toEqual(NOW);

    const renamed = computeHomeSave(
      draft('venta', { status: 'venta', data: published.data, slugLocked: true, firstPublishedAt: NOW }),
      { data: { ...fullVenta(), title: { es: 'Otro título', en: 'Other', de: 'Andere' } } },
      SITE,
      NOW,
    );
    expect(renamed.ok && renamed.data.slugs).toEqual(published.data.slugs);
  });
});

describe('historial de precios', () => {
  it('el primer cambio apunta el precio de alta y el nuevo; el mismo día, solo el último', () => {
    const h1 = nextPriceHistory([], 900000, 850000, { today: '2026-11-19', listedAt: '2026-11-01' });
    expect(h1).toEqual([
      { date: '2026-11-01', price: 900000 },
      { date: '2026-11-19', price: 850000 },
    ]);
    const h2 = nextPriceHistory(h1, 850000, 820000, { today: '2026-11-19' });
    expect(h2).toEqual([
      { date: '2026-11-01', price: 900000 },
      { date: '2026-11-19', price: 820000 },
    ]);
    // Volver el mismo día al precio anterior borra la entrada de hoy.
    expect(nextPriceHistory(h2, 820000, 900000, { today: '2026-11-19' })).toEqual([{ date: '2026-11-01', price: 900000 }]);
    expect(nextPriceHistory(h1, 850000, 850000, { today: '2026-11-20' })).toEqual(h1);
  });

  it('se apunta solo en una casa ya publicada, y showHistory lo decide la agente', () => {
    const before = computeHomeSave(draft('venta'), { data: { ...fullVenta(), price: 700000 } }, SITE, NOW);
    expect(before.ok && before.data.priceHistory).toEqual([]);

    const live = draft('venta', { status: 'venta', data: { ...fullVenta(), priceHistory: [] }, slugLocked: true, firstPublishedAt: new Date('2026-11-02T00:00:00Z') });
    const r = computeHomeSave(live, { data: { ...fullVenta(), price: 800000, showHistory: true } }, SITE, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.priceHistory).toEqual([
      { date: '2026-11-01', price: 850000 },
      { date: madridToday(NOW), price: 800000 },
    ]);
    expect(r.data.showHistory).toBe(true);
    expect(r.changes.price).toEqual({ from: 850000, to: 800000 });
    expect(r.affectsWeb).toBe(true);
  });

  it('lo que llegue en el cuerpo como priceHistory se ignora', () => {
    const live = draft('venta', { status: 'venta', data: fullVenta(), slugLocked: true, firstPublishedAt: NOW });
    const r = computeHomeSave(live, { data: { ...fullVenta(), priceHistory: [{ date: '2020-01-01', price: 1 }] } }, SITE, NOW);
    expect(r.ok && r.data.priceHistory).toEqual([]);
  });
});

describe('validación con las reglas de la web', () => {
  it('un borrador vacío se guarda, con la lista de lo que falta en español', () => {
    const r = computeHomeSave(draft('venta'), { data: initialHomeData('venta', SITE, NOW) }, SITE, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('borrador');
    expect(r.errors.length).toBeGreaterThan(3);
    const messages = r.errors.map((e) => e.message).join('\n');
    expect(messages).toMatch(/Precio: falta/);
    // Las reglas propias de la web (superRefine: el certificado, la temporada)
    // solo corren cuando lo básico ya valida: es Zod, igual que en su build.
    // El aviso del certificado sale al completar lo demás.
    expect(messages).not.toMatch(/certificado energético/);
    expect(messages).not.toMatch(/C-101/);
    expect(messages).not.toMatch(/Required/);
  });

  it('una ficha completa no tiene errores y su candidata valida con el esquema copiado de la web', () => {
    for (const [op, data, schema] of [
      ['venta', fullVenta(), ventaFeedSchema],
      ['alquiler', fullAlquiler(), alquilerFeedSchema],
    ] as const) {
      const status = op === 'venta' ? 'venta' : 'disponible';
      const r = computeHomeSave(draft(op), { status, data }, SITE, NOW);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.errors).toEqual([]);
      const parsed = schema.safeParse({ ...r.data, ref: op === 'venta' ? 'C-101' : 'A-201', status, photos: [] });
      expect(parsed.success).toBe(true);
    }
  });

  it('aplica las reglas propias de la web (certificado, temporada, garantía)', () => {
    const noEnergy = { ...fullVenta() };
    delete noEnergy.energy;
    expect(validateHome('venta', { ref: 'C-101', status: 'venta', data: withSlugs(noEnergy) }, SITE).map((e) => e.message)).toContain(
      'falta el certificado energético. Sin él la casa no se puede publicar.',
    );
    // Una parcela puede ir sin certificado.
    expect(validateHome('venta', { ref: 'C-101', status: 'venta', data: withSlugs({ ...noEnergy, type: 'parcela' }) }, SITE)).toEqual([]);

    const tooMuch = { ...fullAlquiler(), guarantee: 2 };
    expect(validateHome('alquiler', { ref: 'A-201', status: 'disponible', data: withSlugs(tooMuch, 'A-201') }, SITE).map((e) => e.path)).toContain('guarantee');
    const longWithMonths = { ...fullAlquiler(), term: 'larga' };
    expect(validateHome('alquiler', { ref: 'A-201', status: 'disponible', data: withSlugs(longWithMonths, 'A-201') }, SITE).map((e) => e.path)).toContain('months');
  });

  it('un agente que no es de la agencia es un aviso', () => {
    const errors = validateHome('venta', { ref: 'C-101', status: 'venta', data: withSlugs({ ...fullVenta(), agent: 'daniel' }) }, SITE);
    expect(errors).toContainEqual({ path: 'agent', message: 'Agente: no está en la lista de la agencia.' });
  });

  it('una casa con errores se guarda igual, pero no se publica ni congela nada', () => {
    const data = { ...fullVenta() };
    delete data.price;
    const r = computeHomeSave(draft('venta'), { status: 'venta', data }, SITE, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe('venta');
    expect(r.errors.length).toBe(1);
    expect(r.firstPublishedAt).toBeNull();
    expect(r.slugLocked).toBe(false);
    expect(r.affectsWeb).toBe(false);
  });
});

describe('estados', () => {
  it('solo los estados de la operación, más borrador', () => {
    expect(HOME_STATUSES.venta).toEqual(['borrador', 'proximamente', 'venta', 'reservada', 'vendida']);
    expect(HOME_STATUSES.alquiler).toEqual(['borrador', 'disponible', 'reservada', 'alquilada']);
    const r = computeHomeSave(draft('alquiler'), { status: 'vendida', data: fullAlquiler() }, SITE, NOW);
    expect(r).toEqual({ ok: false, error: 'invalid_status' });
  });

  it('una casa publicada no vuelve a borrador', () => {
    const live = draft('venta', { status: 'venta', data: fullVenta(), slugLocked: true, firstPublishedAt: NOW });
    expect(computeHomeSave(live, { status: 'borrador', data: fullVenta() }, SITE, NOW)).toEqual({ ok: false, error: 'published_to_draft' });
    const sold = computeHomeSave(live, { status: 'vendida', data: fullVenta() }, SITE, NOW);
    expect(sold.ok && sold.changes.status).toEqual({ from: 'venta', to: 'vendida' });
    expect(sold.ok && sold.affectsWeb).toBe(true);
  });

  it('un cambio en un borrador no toca la web', () => {
    const r = computeHomeSave(draft('venta'), { data: fullVenta() }, SITE, NOW);
    expect(r.ok && r.affectsWeb).toBe(false);
  });

  it('una casa que deja de validar sí toca la web: hay que retirarla', () => {
    const live = draft('venta', { status: 'venta', data: fullVenta(), errors: null, slugLocked: true, firstPublishedAt: NOW });
    const broken = { ...fullVenta() };
    delete broken.energy;
    const r = computeHomeSave(live, { data: broken }, SITE, NOW);
    expect(r.ok && r.errors.length).toBe(1);
    expect(r.ok && r.affectsWeb).toBe(true);
  });

  it('una ficha enorme se rechaza', () => {
    const r = computeHomeSave(draft('venta'), { data: { ...fullVenta(), summary: { es: 'x'.repeat(70_000), en: '', de: '' } } }, SITE, NOW);
    expect(r).toEqual({ ok: false, error: 'too_large' });
  });
});

describe('borrar', () => {
  it('solo un borrador nunca publicado', () => {
    expect(canDeleteHome({ status: 'borrador', firstPublishedAt: null })).toBe(true);
    expect(canDeleteHome({ status: 'venta', firstPublishedAt: null })).toBe(false);
    expect(canDeleteHome({ status: 'borrador', firstPublishedAt: NOW })).toBe(false);
  });
});

describe('datos limpios', () => {
  it('quita vacíos y claves que no son del formato', () => {
    expect(sanitizeHomeData('venta', { price: 1, plot: null, summary: '', hack: '<script>', rent: 900 })).toEqual({ price: 1 });
    expect(sanitizeHomeData('alquiler', { rent: 900, price: 1, tags: ['piscina'] })).toEqual({ rent: 900 });
  });

  it('una casa nueva nace con la fecha de hoy y el primer agente', () => {
    expect(initialHomeData('venta', SITE, NOW)).toMatchObject({ listedAt: '2026-11-19', agent: 'lucia' });
    expect(initialHomeData('alquiler', { agents: [] }, NOW)).toMatchObject({ term: 'larga', furnished: false, pets: false });
    expect(initialHomeData('alquiler', { agents: [] }, NOW).agent).toBeUndefined();
  });
});

describe('vídeo y recorrido: solo el identificador', () => {
  it('entiende los enlaces de los tres proveedores', () => {
    expect(parseMediaLink('https://my.matterport.com/show/?m=SxQL3iGyoDo')).toEqual({ kind: 'matterport', id: 'SxQL3iGyoDo' });
    expect(parseMediaLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toEqual({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseMediaLink('youtu.be/dQw4w9WgXcQ')).toEqual({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseMediaLink('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toEqual({ kind: 'youtube', id: 'dQw4w9WgXcQ' });
    expect(parseMediaLink('https://vimeo.com/76979871')).toEqual({ kind: 'vimeo', id: '76979871' });
    expect(parseMediaLink('https://player.vimeo.com/video/76979871')).toEqual({ kind: 'vimeo', id: '76979871' });
  });

  it('rechaza otros dominios, HTML e identificadores sin la forma de la web', () => {
    for (const bad of ['https://evil.example/watch?v=dQw4w9WgXcQ', '<iframe src="https://youtube.com/embed/x">', 'https://my.matterport.com/show/?m=short', 'https://vimeo.com/abc', 'javascript:alert(1)', '']) {
      expect(parseMediaLink(bad)).toBeNull();
    }
  });
});

describe('opciones del formulario', () => {
  // Si la web añade o quita un valor, el formulario tiene que seguirla.
  const venta = ventaFeedSchema.innerType().shape;
  const alquiler = alquilerFeedSchema.innerType().shape;
  const values = (list: Array<{ value: string }>) => list.map((o) => o.value).sort();

  it('coinciden con los enums del esquema de la web', () => {
    expect(values(VENTA_TYPES)).toEqual([...venta.type.options].sort());
    expect(values(ALQUILER_TYPES)).toEqual([...alquiler.type.options].sort());
    expect(values(ZONES)).toEqual([...venta.zone.options].sort());
    expect(values(VENTA_TAGS)).toEqual([...venta.tags.removeDefault().element.options].sort());
    expect(values(ALQUILER_INCLUDES)).toEqual([...alquiler.includes.removeDefault().element.options].sort());
    expect(values(ALQUILER_TERMS)).toEqual([...alquiler.term.options].sort());
    expect([...ENERGY_LETTERS]).toEqual([...alquiler.energy.shape.consumo.options]);
  });
});
