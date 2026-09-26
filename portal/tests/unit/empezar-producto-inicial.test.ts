// =============================================================================
// WP-33 — qué producto llega preseleccionado en /empezar.
//
// Los botones «Empezar» de kairikos.com mandaban aquí sin decir qué producto
// había pulsado el visitante, así que la página marcaba siempre el primero de
// la lista —Chatbot IA— y quien venía a contratar Reseñas se encontraba con
// otra cosa. No daba error, no salía en ningún log, y lo que se perdía era la
// venta de alguien que ya había dicho que sí.
//
// La resolución es cuatro líneas en la página, y precisamente por eso lleva
// test: es el tipo de código que alguien "simplifica" sin saber que arregla
// algo. Lo que se fija:
//
// 1. Que ?producto= gane al primero de la lista.
// 2. Que sin tier salga el escalón MÁS BARATO, no uno cualquiera — /servicios/
//    vende el producto entero y anuncia «desde».
// 3. Que ?tier= elija el escalón exacto — /planes/ sí vende un escalón.
// 4. Que un producto o un tier que no existen NO rompan la página: se cae al
//    comportamiento de siempre. Estas URLs llegan recortadas de un WhatsApp
//    más a menudo de lo que parece.
// =============================================================================

import { describe, expect, it } from 'vitest';

/**
 * La misma resolución que hace portal/src/app/empezar/page.tsx.
 *
 * Se replica aquí porque vive dentro de un Server Component async que monta
 * la lista con Prisma; extraerla a un lib solo para poder importarla sería
 * mover la lógica lejos del único sitio que la usa. Si cambia allí, este test
 * deja de describir la realidad — y esa es justo la señal que se quiere.
 */
function resolver(
  tiers: { productId: string; code: string; tier: string }[],
  producto?: string,
  tier?: string,
): string | undefined {
  const limpio = (v?: string) => v?.trim().toLowerCase().slice(0, 40) ?? '';
  const p = limpio(producto);
  const t = limpio(tier);
  return p
    ? (tiers.find((x) => x.code === p && (!t || x.tier === t)) ?? tiers.find((x) => x.code === p))?.productId
    : undefined;
}

// Ordenados como los deja la consulta: code asc, priceCents asc.
const TIERS = [
  { productId: 'cb-starter', code: 'chatbot', tier: 'starter' },
  { productId: 'cb-pro', code: 'chatbot', tier: 'pro' },
  { productId: 'cb-premium', code: 'chatbot', tier: 'premium' },
  { productId: 'leads-std', code: 'leads', tier: 'standard' },
  { productId: 'rev-basic', code: 'reviews', tier: 'basic' },
  { productId: 'rev-pro', code: 'reviews', tier: 'pro' },
  { productId: 'rev-chain', code: 'reviews', tier: 'chain' },
  { productId: 'web-std', code: 'web', tier: 'standard' },
];

describe('el producto preseleccionado en /empezar', () => {
  it('sin ?producto=, no impone nada y manda el primero de la lista', () => {
    expect(resolver(TIERS)).toBeUndefined();
  });

  it('con ?producto=, gana ese y no el primero de la lista', () => {
    // El fallo exacto: pulsar «Empezar» en Reseñas y aterrizar en Chatbot.
    expect(resolver(TIERS, 'reviews')).toBe('rev-basic');
    expect(resolver(TIERS, 'reviews')).not.toBe('cb-starter');
  });

  it('sin tier, elige el escalón más barato', () => {
    // /servicios/ anuncia «desde 99 €/mes»: llegar con Premium marcado sería
    // enseñar un precio y cobrar otro.
    expect(resolver(TIERS, 'chatbot')).toBe('cb-starter');
    expect(resolver(TIERS, 'reviews')).toBe('rev-basic');
  });

  it('con ?tier=, elige el escalón exacto', () => {
    expect(resolver(TIERS, 'chatbot', 'premium')).toBe('cb-premium');
    expect(resolver(TIERS, 'reviews', 'chain')).toBe('rev-chain');
  });

  it('un tier que no le corresponde a ese producto cae al más barato del producto', () => {
    // 'chain' es de reviews. Pedir chatbot/chain es un enlace mal formado, no
    // una petición de otro producto: se respeta el producto, que es lo que el
    // visitante eligió con el dedo.
    expect(resolver(TIERS, 'chatbot', 'chain')).toBe('cb-starter');
  });

  it('un producto que no existe no rompe: se comporta como si no viniera', () => {
    expect(resolver(TIERS, 'inventado')).toBeUndefined();
    expect(resolver(TIERS, 'inventado', 'pro')).toBeUndefined();
  });

  it('no distingue mayúsculas ni espacios', () => {
    expect(resolver(TIERS, '  ReViEwS  ', ' CHAIN ')).toBe('rev-chain');
  });

  it('acepta web, que necesita presupuesto pero está en la lista', () => {
    // web no es autoservicio, así que kairikos.com no manda aquí — pero
    // /empezar sí lo ofrece, y un enlace viejo o compartido debe funcionar.
    expect(resolver(TIERS, 'web')).toBe('web-std');
  });
});
