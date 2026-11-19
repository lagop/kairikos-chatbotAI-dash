// =============================================================================
// Cartera — el test de contrato del feed (docs/fase1-cartera.md, «El formato
// propio»). El esquema vive en la plantilla web; lib/cartera/schema.ts es su
// copia. Los ejemplos son las casas de la demo Alféizar
// (tests/fixtures/cartera/demo-homes.json), las mismas que usa el test de la
// web: si uno de los dos repositorios cambia el formato sin el otro, falla.
//
// Además fija las reglas de qué sale en el feed: nunca un borrador ni una casa
// con errores; las vendidas y alquiladas sí.
// =============================================================================

import { describe, expect, it } from 'vitest';
import demo from '../fixtures/cartera/demo-homes.json';
import { alquilerDataSchema, carteraFeedSchema, ventaDataSchema } from '@/lib/cartera/schema';
import { buildFeed, etagMatches, isPublishable, type FeedHomeRow } from '@/lib/cartera/feed';

const BASE = 'https://portal.example.test';
const NOW = new Date('2026-11-19T10:00:00Z');

let seq = 0;
function photoId(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

function row(operation: 'venta' | 'alquiler', data: Record<string, unknown>, over: Partial<FeedHomeRow> = {}): FeedHomeRow {
  return {
    ref: String(data.ref),
    operation,
    status: String(data.status),
    data,
    errors: null,
    photos: [
      { id: photoId(), width: 2400, height: 1600, position: 1, alt: { es: 'Salón', en: 'Living room', de: 'Wohnzimmer' } },
      { id: photoId(), width: 2400, height: 1600, position: 0, alt: null },
    ],
    ...over,
  };
}

const demoRows = (): FeedHomeRow[] => [
  ...demo.ventas.map((v) => row('venta', v as Record<string, unknown>)),
  ...demo.alquileres.map((a) => row('alquiler', a as Record<string, unknown>)),
];

describe('las casas de la demo son el formato propio', () => {
  it('cada venta valida contra el esquema de datos', () => {
    expect(demo.ventas.length).toBeGreaterThan(0);
    for (const v of demo.ventas) expect(ventaDataSchema.safeParse(v).success, String(v.ref)).toBe(true);
  });

  it('cada alquiler valida contra el esquema de datos', () => {
    expect(demo.alquileres.length).toBeGreaterThan(0);
    for (const a of demo.alquileres) expect(alquilerDataSchema.safeParse(a).success, String(a.ref)).toBe(true);
  });

  it('no llevan lo que se queda en el repositorio de la web (plano, nivel, reforma)', () => {
    for (const h of [...demo.ventas, ...demo.alquileres]) {
      expect(h).not.toHaveProperty('plan');
      expect(h).not.toHaveProperty('level');
      expect(h).not.toHaveProperty('reform');
    }
  });
});

describe('el feed generado valida contra el esquema de la web', () => {
  it('con todas las casas de la demo', () => {
    const { feed, skipped } = buildFeed(demoRows(), { baseUrl: BASE, now: NOW });
    expect(skipped).toEqual([]);
    expect(feed.ventas).toHaveLength(demo.ventas.length);
    expect(feed.alquileres).toHaveLength(demo.alquileres.length);

    const parsed = carteraFeedSchema.safeParse(JSON.parse(JSON.stringify(feed)));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    expect(feed).toMatchObject({ version: 1, generatedAt: '2026-11-19T10:00:00.000Z' });
  });

  it('cada casa lleva sus fotos por orden, con URL del portal y alt en los tres idiomas', () => {
    const { feed } = buildFeed(demoRows(), { baseUrl: BASE, now: NOW });
    const first = feed.ventas[0];
    expect(first.photos).toHaveLength(2);
    // La de position 0 es la portada aunque llegue la segunda.
    expect(first.photos[0].alt).toEqual({ es: '', en: '', de: '' });
    expect(first.photos[1].alt).toEqual({ es: 'Salón', en: 'Living room', de: 'Wohnzimmer' });
    expect(first.photos[0].url).toMatch(/^https:\/\/portal\.example\.test\/api\/public\/cartera\/foto\/[0-9a-f-]{36}$/);
    expect(first.photos[0]).toMatchObject({ width: 2400, height: 1600 });
  });

  it('referencia y estado salen de las columnas, no del JSON', () => {
    const v = demo.ventas[0] as Record<string, unknown>;
    const { feed } = buildFeed([row('venta', { ...v, status: 'venta' }, { status: 'reservada' })], { baseUrl: BASE, now: NOW });
    expect(feed.ventas[0].status).toBe('reservada');
  });
});

describe('qué casas salen en el feed', () => {
  const venta = demo.ventas[0] as Record<string, unknown>;
  const alquiler = demo.alquileres[0] as Record<string, unknown>;

  it('un borrador nunca sale', () => {
    const { feed } = buildFeed([row('venta', venta, { status: 'borrador' }), row('alquiler', alquiler, { status: 'borrador' })], { baseUrl: BASE });
    expect(feed.ventas).toEqual([]);
    expect(feed.alquileres).toEqual([]);
  });

  it('una casa con errores no sale (sin certificado energético, por ejemplo)', () => {
    const errors = [{ path: ['energy'], message: 'falta el certificado energético' }];
    const { feed } = buildFeed([row('venta', venta, { errors })], { baseUrl: BASE });
    expect(feed.ventas).toEqual([]);
  });

  it('errores vacíos ([] o {}) cuentan como sin errores', () => {
    expect(isPublishable({ status: 'venta', errors: [] })).toBe(true);
    expect(isPublishable({ status: 'venta', errors: {} })).toBe(true);
    expect(isPublishable({ status: 'venta', errors: [{ message: 'x' }] })).toBe(false);
    expect(isPublishable({ status: 'borrador', errors: null })).toBe(false);
  });

  it('las vendidas y alquiladas sí salen, con su estado', () => {
    const { feed } = buildFeed([row('venta', venta, { status: 'vendida' }), row('alquiler', alquiler, { status: 'alquilada' })], { baseUrl: BASE });
    expect(feed.ventas.map((h) => h.status)).toEqual(['vendida']);
    expect(feed.alquileres.map((h) => h.status)).toEqual(['alquilada']);
  });

  it('una casa sin errores apuntados que no valida se queda fuera, y no tumba el resto', () => {
    const { energy: _energy, ...sinCertificado } = venta;
    const other = demo.ventas[1] as Record<string, unknown>;
    const { feed, skipped } = buildFeed([row('venta', sinCertificado), row('venta', other)], { baseUrl: BASE });
    expect(skipped).toEqual([{ ref: String(venta.ref), reason: 'invalid' }]);
    expect(feed.ventas.map((h) => h.ref)).toEqual([other.ref]);
  });

  it('un estado de venta en un alquiler no valida', () => {
    const { skipped } = buildFeed([row('alquiler', alquiler, { status: 'vendida' })], { baseUrl: BASE });
    expect(skipped).toHaveLength(1);
  });
});

describe('ETag del feed', () => {
  it('no cambia con generatedAt, sí con el contenido', () => {
    const a = buildFeed(demoRows().map((r, i) => ({ ...r, photos: r.photos.map((p, j) => ({ ...p, id: `00000000-0000-4000-8000-${String(i * 10 + j).padStart(12, '0')}` })) })), { baseUrl: BASE, now: NOW });
    const b = buildFeed(demoRows().map((r, i) => ({ ...r, photos: r.photos.map((p, j) => ({ ...p, id: `00000000-0000-4000-8000-${String(i * 10 + j).padStart(12, '0')}` })) })), { baseUrl: BASE, now: new Date() });
    expect(a.etag).toBe(b.etag);

    const changed = demoRows();
    changed[0] = { ...changed[0], status: 'reservada' };
    expect(buildFeed(changed, { baseUrl: BASE }).etag).not.toBe(a.etag);
  });

  it('If-None-Match admite listas y etiquetas débiles', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x"', '"abc"')).toBe(false);
    expect(etagMatches(null, '"abc"')).toBe(false);
  });
});
