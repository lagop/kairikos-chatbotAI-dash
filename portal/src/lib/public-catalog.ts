import 'server-only';

import type { PrismaClient } from '@prisma/client';
import { annualPriceCents } from './annual-billing';
import { ADDONS, isAddonCode } from './addon-catalog';
import { COMBO_PACKS, packPricing, type ComboPackCode } from './combo-packs';
import { PRODUCT_CATALOGS, PRODUCT_CODES, type ProductCode } from '@/lib/catalogs';

// =============================================================================
// El catálogo, tal y como lo ve kairikos.com.
//
// Hasta el 26/09/2026 nada ataba la web al portal. Los precios se escribían a
// mano en las plantillas de WordPress, y el 25/09 se encontraron SEIS páginas
// vendiendo a precios que no se cobran —la portada, /planes/, /resenas-google/,
// /chatbot-7-dias-2/ y tres landings sectoriales—, además de la respuesta
// enlatada del chat del propio sitio diciendo «los chatbots empiezan desde
// 500 €». Ninguna dio nunca un error: se fueron encontrando de una en una, por
// casualidad.
//
// Esta ruta existe para que la web deje de adivinar. NO la consume el
// navegador del visitante: la consume un script del repositorio de los temas,
// que genera un archivo PHP commiteado, y una comprobación que corre por cron
// y avisa cuando el archivo se ha quedado atrás. Es a propósito —ver el README
// de kairikos_web—: delante de la web hay una caché de página completa, así
// que leer en vivo no llegaría antes al visitante, y a cambio una edición mala
// en esta base de datos saldría publicada sin que nadie la revise.
//
// De aquí sale SOLO lo que ya es público en /planes/: código, escalón, nombre,
// importes y si se contrata sin hablar con nadie. Nunca ids de Stripe, ni el
// modo test/live, ni nada de ClientProduct.
// =============================================================================

/**
 * Los nombres de escalón que ve una persona.
 *
 * Esto vivía duplicado en /empezar y en /portal/productos, con un comentario
 * que decía que duplicarlo no costaba nada «porque es formato, no lógica de
 * negocio». Era verdad mientras los dos sitios fueran pantallas internas: si
 * una decía «Solo» y la otra «Autónomo», se notaba y se arreglaba.
 *
 * Deja de ser verdad en cuanto estos nombres se publican en kairikos.com. Una
 * tercera copia habría sido la que se queda atrás, que es exactamente cómo el
 * mismo sector acabó llamándose «Clínicas», «Clínicas Dentales» y «Clinicas
 * Dentales» en la misma página de la web.
 */
export const TIER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  standard: 'Estándar',
  // Plan de precios del 01/10/2026: Llamadas Esencial, y el Starter del
  // chatbot pasa a llamarse por lo que hace (solo la web). El código del
  // escalón no cambia: lo llevan Stripe, las suscripciones y el asistente.
  essential: 'Esencial',
  solo: 'Autónomo',
  team: 'Equipo',
  business: 'Empresa',
  starter: 'Web',
  pro: 'Pro',
  premium: 'Premium',
  basic: 'Basic',
  chain: 'Cadena',
});

export function tierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? tier.charAt(0).toUpperCase() + tier.slice(1);
}

export interface PublicCatalogTier {
  tier: string;
  /** 'Autónomo', 'Cadena'… tal y como se enseña. */
  tierLabel: string;
  /** Cuota mensual en céntimos. 0 en los productos de pago único. */
  priceCents: number;
  /** Cuota de alta en céntimos. 0 cuando no la lleva. */
  setupFeeCents: number;
  currency: string;
  /**
   * Si un visitante puede contratarlo desde /empezar sin que un operador
   * cree la cuenta antes. Es la columna Product.selfServeEligible, que existe
   * justamente para poder encender y apagar un escalón sin desplegar — así
   * que la web tampoco debe tener su propia lista de cuáles son.
   */
  selfServe: boolean;
  /**
   * Plan de precios del 01/10/2026 — lo que cuesta el año pagado de una vez
   * (12 meses por el precio de 10, sin alta), en céntimos. Null mientras el
   * escalón no tenga precio anual creado en Stripe: la web no debe anunciar un
   * pago que el portal todavía no sabe cobrar.
   */
  annualPriceCents: number | null;
}

/** Plan de precios del 01/10/2026 — un complemento que se contrata encima
 *  del producto (Cuidado de la web). */
export interface PublicCatalogAddon {
  code: string;
  label: string;
  /** Cuota mensual en céntimos. */
  priceCents: number;
  /** El año pagado de una vez, o null sin precio anual en Stripe. */
  annualPriceCents: number | null;
  currency: string;
}

export interface PublicCatalogProduct {
  code: string;
  /** 'Chatbot IA', 'Reseñas en Google'… del catálogo de producto del portal. */
  label: string;
  tiers: PublicCatalogTier[];
  /** Los complementos de este producto. Vacío casi siempre. */
  addons: PublicCatalogAddon[];
}

/** Plan de precios del 01/10/2026 — un pack de productos con su precio,
 *  calculado de los precios reales del catálogo (lib/combo-packs.ts). */
export interface PublicCatalogPack {
  code: string;
  label: string;
  /** Lo que lleva, tal como se enseña: «Llamadas Autónomo», «Reseñas Basic». */
  components: string[];
  monthlyCents: number;
  separateMonthlyCents: number;
  /** Pago único (la web), 0 si no lleva. */
  oneTimeCents: number;
}

export interface PublicCatalog {
  /** ISO-8601. Para que quien lo consuma sepa de cuándo es lo que tiene. */
  generatedAt: string;
  products: PublicCatalogProduct[];
  packs: PublicCatalogPack[];
}

function isProductCode(value: string): value is ProductCode {
  return (PRODUCT_CODES as readonly string[]).includes(value);
}

/**
 * Ordena los escalones de más barato a más caro por cuota mensual, y a igualdad
 * por cuota de alta.
 *
 * El orden importa: la web enseña «desde X €/mes» tomando el primero. Dejarlo
 * al orden de inserción de Postgres haría que un escalón nuevo cambiara el
 * precio que anuncia la portada, sin que nadie tocara la portada.
 */
function porPrecio(a: PublicCatalogTier, b: PublicCatalogTier): number {
  return a.priceCents - b.priceCents || a.setupFeeCents - b.setupFeeCents;
}

type ProductRow = {
  code: string;
  tier: string;
  priceCents: number;
  setupFeeCents: number;
  currency: string;
  selfServeEligible: boolean;
  stripeAnnualPriceId?: string | null;
  /** 'plan' | 'addon'. Ausente = 'plan' (las filas de antes de la columna). */
  kind?: string;
};

/** Agrupa filas de Product en la forma que se publica. Pura, para poder testearla. */
export function buildPublicCatalog(rows: ProductRow[], generatedAt: Date): PublicCatalog {
  const porCodigo = new Map<string, PublicCatalogTier[]>();
  const complementos = new Map<string, PublicCatalogAddon[]>();

  for (const row of rows) {
    // Un complemento se publica colgando de su producto, no como uno más.
    // Uno sin entrada en ADDONS no tiene dónde colgarse y no se publica: un
    // complemento suelto en la web no se podría contratar desde ningún sitio.
    if ((row.kind ?? 'plan') === 'addon') {
      if (!isAddonCode(row.code)) continue;
      const padre = ADDONS[row.code].appliesTo;
      const lista = complementos.get(padre) ?? [];
      lista.push({
        code: row.code,
        label: ADDONS[row.code].label,
        priceCents: row.priceCents,
        annualPriceCents: row.stripeAnnualPriceId && row.priceCents > 0 ? annualPriceCents(row.priceCents) : null,
        currency: row.currency,
      });
      complementos.set(padre, lista);
      continue;
    }
    const tiers = porCodigo.get(row.code) ?? [];
    tiers.push({
      tier: row.tier,
      tierLabel: tierLabel(row.tier),
      priceCents: row.priceCents,
      setupFeeCents: row.setupFeeCents,
      currency: row.currency,
      selfServe: row.selfServeEligible,
      annualPriceCents: row.stripeAnnualPriceId && row.priceCents > 0 ? annualPriceCents(row.priceCents) : null,
    });
    porCodigo.set(row.code, tiers);
  }

  // El orden de los productos sale de PRODUCT_CODES, no de la base de datos:
  // así el archivo generado en el repositorio de los temas no cambia de orden
  // solo porque alguien haya reinsertado una fila, y su diff sigue siendo
  // legible.
  const products: PublicCatalogProduct[] = [];
  for (const code of PRODUCT_CODES) {
    const tiers = porCodigo.get(code);
    if (!tiers || tiers.length === 0) continue;
    products.push({
      code,
      label: PRODUCT_CATALOGS[code].label,
      tiers: tiers.sort(porPrecio),
      addons: complementos.get(code) ?? [],
    });
  }

  // Un código que no esté en PRODUCT_CODES no se descarta en silencio: `code`
  // es texto libre en el esquema justamente para poder añadir un producto sin
  // migración, y tragárselo aquí sería la forma perfecta de que un producto
  // nuevo nunca llegue a la web.
  for (const [code, tiers] of porCodigo) {
    if (isProductCode(code)) continue;
    products.push({ code, label: code, tiers: tiers.sort(porPrecio), addons: complementos.get(code) ?? [] });
  }

  // Los packs, con el precio que sale de lo que hay hoy en el catálogo. Un
  // pack al que le falta una pieza (inactiva, aún no creada) no se publica.
  const packs: PublicCatalogPack[] = [];
  for (const code of Object.keys(COMBO_PACKS) as ComboPackCode[]) {
    const pricing = packPricing(code, rows);
    if (!pricing) continue;
    packs.push({
      code,
      label: COMBO_PACKS[code].label,
      components: COMBO_PACKS[code].components.map((c) => c.label),
      ...pricing,
    });
  }

  return { generatedAt: generatedAt.toISOString(), products, packs };
}

/** Lee el catálogo activo. Solo columnas públicas: ningún id de Stripe sale de aquí. */
export async function loadPublicCatalog(
  prisma: Pick<PrismaClient, 'product'>,
  now: Date = new Date(),
): Promise<PublicCatalog> {
  const rows = await prisma.product.findMany({
    // Planes y complementos. Los packs de uso (kind 'pack', 01/10/2026) se
    // compran desde su propia tarjeta en el portal, no desde la web.
    where: { isActive: true, kind: { in: ['plan', 'addon'] } },
    orderBy: [{ code: 'asc' }, { priceCents: 'asc' }],
    select: {
      code: true,
      tier: true,
      priceCents: true,
      setupFeeCents: true,
      currency: true,
      selfServeEligible: true,
      stripeAnnualPriceId: true,
      kind: true,
    },
  });

  return buildPublicCatalog(rows, now);
}
