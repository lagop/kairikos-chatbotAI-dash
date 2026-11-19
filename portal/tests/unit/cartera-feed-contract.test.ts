// =============================================================================
// Cartera — el test de contrato del feed (docs/fase1-cartera.md, «El formato
// propio»). El esquema vive en la plantilla web; lib/cartera/schema.ts es su
// copia literal. El ejemplo es el mismo que valida el test de la web
// (tests/fixtures/cartera/cartera-feed.json = su tests/fixtures/cartera-feed.json):
// si uno de los dos repositorios cambia el formato sin el otro, falla.
//
// Además fija que lo que GENERA el portal es ese formato —una casa del ejemplo
// guardada como fila del portal sale igual en el feed— y las reglas de qué
// sale: nunca un borrador ni una casa con errores; las vendidas y alquiladas sí.
// =============================================================================

import { describe, expect, it } from 'vitest';
import example from '../fixtures/cartera/cartera-feed.json';
import { alquilerFeedSchema, feedSchema, ventaFeedSchema } from '@/lib/cartera/schema';
import { buildFeed, etagMatches, isPublishable, type CarteraFeed, type FeedHomeRow } from '@/lib/cartera/feed';

const BASE = 'https://portal.example.test';
const NOW = new Date('2026-11-19T10:00:00Z');

type Home = Record<string, unknown> & { ref: string; status: string };
const ventas = example.ventas as unknown as Home[];
const alquileres = example.alquileres as unknown as Home[];

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Una casa del ejemplo como la guardaría el portal: `data` sin fotos, fotos en su tabla. */
function row(operation: 'venta' | 'alquiler', home: Home, over: Partial<FeedHomeRow> = {}): FeedHomeRow {
  const { photos: _photos, ...data } = home;
  return { ref: home.ref, operation, status: home.status, data, errors: null, photos: [], ...over };
}

const exampleRows = (): FeedHomeRow[] => [...ventas.map((h) => row('venta', h)), ...alquileres.map((h) => row('alquiler', h))];

/** Lo que exige la web: el envoltorio y, una a una, cada casa. */
function expectValidFeed(feed: CarteraFeed) {
  const json = JSON.parse(JSON.stringify(feed));
  expect(feedSchema.safeParse(json).success).toBe(true);
  for (const h of json.ventas) {
    const r = ventaFeedSchema.safeParse(h);
    expect(r.success, `${h.ref}: ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 2))}`).toBe(true);
  }
  for (const h of json.alquileres) {
    const r = alquilerFeedSchema.safeParse(h);
    expect(r.success, `${h.ref}: ${r.success ? '' : JSON.stringify(r.error.issues.slice(0, 2))}`).toBe(true);
  }
}

describe('el ejemplo de la web valida contra la copia del esquema', () => {
  it('el envoltorio', () => {
    expect(feedSchema.safeParse(example).success).toBe(true);
  });

  it('cada casa, una a una', () => {
    expect(ventas.length).toBeGreaterThan(0);
    expect(alquileres.length).toBeGreaterThan(0);
    expectValidFeed(example as unknown as CarteraFeed);
  });

  it('un campo de más es un error: el plano nunca viaja en el feed', () => {
    expect(ventaFeedSchema.safeParse({ ...ventas[0], level: 'escala' }).success).toBe(false);
    expect(alquilerFeedSchema.safeParse({ ...alquileres[0], plan: { floors: [] } }).success).toBe(false);
  });
});

describe('el feed que genera el portal es ese formato', () => {
  it('cada casa del ejemplo, guardada como fila del portal, sale igual en el feed', () => {
    const { feed, skipped } = buildFeed(exampleRows(), { baseUrl: BASE, now: NOW });
    expect(skipped).toEqual([]);
    expectValidFeed(feed);
    expect(feed).toMatchObject({ version: 1, generatedAt: '2026-11-19T10:00:00.000Z' });

    const expected = (schema: typeof ventaFeedSchema | typeof alquilerFeedSchema, h: Home) => schema.parse({ ...h, photos: [] });
    const byRef = <T extends { ref: string }>(list: T[]) => new Map(list.map((h) => [h.ref, h]));
    const vs = byRef(feed.ventas);
    const as = byRef(feed.alquileres);
    for (const h of ventas) expect(vs.get(h.ref), h.ref).toEqual(expected(ventaFeedSchema, h));
    for (const h of alquileres) expect(as.get(h.ref), h.ref).toEqual(expected(alquilerFeedSchema, h));
  });

  it('las fotos salen por orden, con URL https del portal y alt solo en los idiomas que lo tienen', () => {
    const c101 = ventas.find((h) => h.ref === 'C-101')!;
    const { feed } = buildFeed(
      [
        row('venta', c101, {
          photos: [
            { id: id(2), width: 2400, height: 1600, position: 1, alt: { es: 'Salón', en: 'Living room', de: '' } },
            { id: id(1), width: 2400, height: 1600, position: 0, alt: null },
          ],
        }),
      ],
      { baseUrl: BASE },
    );
    expectValidFeed(feed);
    const photos = feed.ventas[0].photos;
    // La de position 0 es la portada aunque llegue la segunda.
    expect(photos.map((p) => p.url)).toEqual([`${BASE}/api/public/cartera/foto/${id(1)}`, `${BASE}/api/public/cartera/foto/${id(2)}`]);
    expect(photos[0].alt).toEqual({});
    expect(photos[1].alt).toEqual({ es: 'Salón', en: 'Living room' });
  });

  it('http solo vale en la máquina local; fuera de ella, la casa con fotos se queda fuera', () => {
    const c101 = ventas.find((h) => h.ref === 'C-101')!;
    const photos = [{ id: id(1), width: 2400, height: 1600, position: 0, alt: null }];
    for (const local of ['http://localhost:3000', 'http://127.0.0.1:3002']) {
      expect(buildFeed([row('venta', c101, { photos })], { baseUrl: local }).skipped, local).toEqual([]);
    }
    expect(buildFeed([row('venta', c101, { photos })], { baseUrl: 'http://portal.example.test' }).skipped).toEqual([{ ref: 'C-101', reason: 'invalid' }]);
  });

  it('las fotos son siempre las de su tabla, nunca un `photos` metido en el JSON', () => {
    const c101 = ventas.find((h) => h.ref === 'C-101')!;
    const { feed } = buildFeed([{ ...row('venta', c101), data: c101 }], { baseUrl: BASE });
    expect(feed.ventas[0].photos).toEqual([]);
  });

  it('referencia y estado salen de las columnas, no del JSON', () => {
    const { feed } = buildFeed([row('venta', { ...ventas[0], status: 'venta' }, { status: 'reservada' })], { baseUrl: BASE });
    expect(feed.ventas[0].status).toBe('reservada');
  });
});

describe('qué casas salen en el feed', () => {
  const venta = ventas[0];
  const alquiler = alquileres[0];

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
    const conCertificado = ventas.find((h) => h.type !== 'parcela' && h.ref !== venta.ref)!;
    const { energy: _energy, ...sinCertificado } = ventas.find((h) => h.type !== 'parcela')!;
    const { feed, skipped } = buildFeed([row('venta', sinCertificado as Home), row('venta', conCertificado)], { baseUrl: BASE });
    expect(skipped).toEqual([{ ref: sinCertificado.ref, reason: 'invalid' }]);
    expect(feed.ventas.map((h) => h.ref)).toEqual([conCertificado.ref]);
  });

  it('un campo que no es del formato en el JSON deja la casa fuera', () => {
    const { skipped } = buildFeed([row('venta', { ...venta, level: 'escala' })], { baseUrl: BASE });
    expect(skipped).toEqual([{ ref: venta.ref, reason: 'invalid' }]);
  });

  it('un estado de venta en un alquiler no valida', () => {
    const { skipped } = buildFeed([row('alquiler', alquiler, { status: 'vendida' })], { baseUrl: BASE });
    expect(skipped).toHaveLength(1);
  });
});

describe('ETag del feed', () => {
  it('no cambia con generatedAt, sí con el contenido', () => {
    const a = buildFeed(exampleRows(), { baseUrl: BASE, now: NOW });
    const b = buildFeed(exampleRows(), { baseUrl: BASE, now: new Date() });
    expect(a.etag).toBe(b.etag);

    const changed = exampleRows();
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
