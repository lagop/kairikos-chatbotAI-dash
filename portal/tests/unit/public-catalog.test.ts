// =============================================================================
// El catálogo que se publica en kairikos.com.
//
// Este lib existe porque el 25/09/2026 SEIS páginas de la web vendían a
// precios que no se cobran, y ninguna dio nunca un error. Los tests de aquí
// fijan lo que tiene que seguir siendo verdad para que el arreglo sirva de
// algo:
//
// 1. Que NO salga nada que no esté ya publicado. La consulta no selecciona
//    ids de Stripe ni el modo test/live; si alguien amplía el `select`, esto
//    lo caza. Es la única capa: la ruta no autentica, a propósito.
// 2. Que el orden sea estable y venga del precio, no de Postgres. La web
//    anuncia «desde X €/mes» tomando el primer escalón: si el orden dependiera
//    del orden de inserción, un escalón nuevo cambiaría el precio de la
//    portada sin que nadie tocara la portada.
// 3. Que `selfServe` salga de la columna y no de una lista. La web tenía su
//    propia lista escrita a mano de qué productos se contratan solos, que es
//    justo lo que `Product.selfServeEligible` existe para evitar.
// 4. Que un código de producto desconocido NO se descarte en silencio.
//    `code` es texto libre a propósito, para poder añadir un producto sin
//    migración; tragárselo aquí sería la forma perfecta de que ese producto
//    nuevo no llegue nunca a la web, sin un solo error por el camino.
//
// El prisma es un objeto a mano: loadPublicCatalog lo recibe por parámetro.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { buildPublicCatalog, loadPublicCatalog, tierLabel } from '@/lib/public-catalog';

const AHORA = new Date('2026-09-26T10:00:00.000Z');

function fila(over: Partial<Parameters<typeof buildPublicCatalog>[0][number]> = {}) {
  return {
    code: 'chatbot',
    tier: 'starter',
    priceCents: 9900,
    setupFeeCents: 39900,
    currency: 'EUR',
    selfServeEligible: true,
    ...over,
  };
}

describe('buildPublicCatalog', () => {
  it('agrupa los escalones por producto y les pone el nombre del portal', () => {
    const cat = buildPublicCatalog(
      [
        fila({ tier: 'starter', priceCents: 9900 }),
        fila({ tier: 'pro', priceCents: 24900 }),
        fila({ code: 'reviews', tier: 'basic', priceCents: 9900, setupFeeCents: 9900 }),
      ],
      AHORA,
    );

    expect(cat.products.map((p) => p.code)).toEqual(['chatbot', 'reviews']);
    expect(cat.products[0].label).toBe('Chatbot IA');
    expect(cat.products[0].tiers).toHaveLength(2);
    expect(cat.generatedAt).toBe('2026-09-26T10:00:00.000Z');
  });

  it('ordena los escalones por precio, no por el orden en que llegan', () => {
    const cat = buildPublicCatalog(
      [
        fila({ tier: 'premium', priceCents: 49900 }),
        fila({ tier: 'starter', priceCents: 9900 }),
        fila({ tier: 'pro', priceCents: 24900 }),
      ],
      AHORA,
    );

    // La web anuncia «desde» tomando el primero.
    expect(cat.products[0].tiers.map((t) => t.tier)).toEqual(['starter', 'pro', 'premium']);
    expect(cat.products[0].tiers[0].priceCents).toBe(9900);
  });

  it('a igual cuota mensual, ordena por cuota de alta', () => {
    const cat = buildPublicCatalog(
      [
        fila({ code: 'reviews', tier: 'pro', priceCents: 14900, setupFeeCents: 0 }),
        fila({ code: 'reviews', tier: 'otro', priceCents: 14900, setupFeeCents: 9900 }),
      ],
      AHORA,
    );

    expect(cat.products[0].tiers.map((t) => t.tier)).toEqual(['pro', 'otro']);
  });

  it('el orden de los productos sale de PRODUCT_CODES, no de la base de datos', () => {
    const cat = buildPublicCatalog(
      [
        fila({ code: 'prospecting', tier: 'solo', priceCents: 12900 }),
        fila({ code: 'chatbot', tier: 'starter', priceCents: 9900 }),
        fila({ code: 'web', tier: 'standard', priceCents: 0, setupFeeCents: 79900 }),
      ],
      AHORA,
    );

    // Si dependiera de la base de datos, el diff del archivo generado en el
    // repositorio de los temas cambiaría al reinsertar una fila.
    expect(cat.products.map((p) => p.code)).toEqual(['chatbot', 'web', 'prospecting']);
  });

  it('un producto desconocido se publica igual, no se descarta en silencio', () => {
    const cat = buildPublicCatalog(
      [fila({ code: 'producto_nuevo_sin_migracion', tier: 'standard', priceCents: 1000 })],
      AHORA,
    );

    expect(cat.products).toHaveLength(1);
    expect(cat.products[0].code).toBe('producto_nuevo_sin_migracion');
    expect(cat.products[0].label).toBe('producto_nuevo_sin_migracion');
  });

  it('selfServe sale de la columna, tal cual', () => {
    const cat = buildPublicCatalog(
      [
        fila({ tier: 'starter', selfServeEligible: true }),
        fila({ code: 'recall', tier: 'solo', priceCents: 14900, selfServeEligible: false }),
      ],
      AHORA,
    );

    expect(cat.products.find((p) => p.code === 'chatbot')!.tiers[0].selfServe).toBe(true);
    expect(cat.products.find((p) => p.code === 'recall')!.tiers[0].selfServe).toBe(false);
  });
});

describe('tierLabel', () => {
  it('traduce los escalones que la web enseña', () => {
    expect(tierLabel('solo')).toBe('Autónomo');
    expect(tierLabel('team')).toBe('Equipo');
    expect(tierLabel('business')).toBe('Empresa');
    expect(tierLabel('chain')).toBe('Cadena');
    expect(tierLabel('standard')).toBe('Estándar');
  });

  it('un escalón sin traducir sale capitalizado, no vacío', () => {
    // Un hueco en blanco se cuela en producción; un «Inventado» en un titular
    // de kairikos.com, no.
    expect(tierLabel('inventado')).toBe('Inventado');
  });
});

describe('loadPublicCatalog', () => {
  it('pide solo columnas públicas y solo productos activos', async () => {
    let capturado: Record<string, unknown> | null = null;
    const prisma = {
      product: {
        findMany: async (args: Record<string, unknown>) => {
          capturado = args;
          return [fila()];
        },
      },
    } as never;

    await loadPublicCatalog(prisma, AHORA);

    expect(capturado).not.toBeNull();
    const args = capturado as unknown as {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    };

    expect(args.where).toEqual({ isActive: true });

    // Esta es la única defensa: la ruta no autentica a propósito, porque lo
    // que devuelve ya está en /planes/. Ampliar el select es lo que la
    // rompería, así que se fija la lista entera.
    expect(Object.keys(args.select).sort()).toEqual([
      'code',
      'currency',
      'priceCents',
      'selfServeEligible',
      'setupFeeCents',
      'tier',
    ]);

    for (const prohibido of [
      'stripeProductId',
      'stripeRecurringPriceId',
      'stripeSetupPriceId',
      'stripePriceMode',
      'id',
    ]) {
      expect(args.select[prohibido]).toBeUndefined();
    }
  });
});
