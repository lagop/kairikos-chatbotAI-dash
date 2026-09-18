import type { PrismaClient } from '@prisma/client';

// =============================================================================
// WP-16 — has this client actually bought the product whose wizard URL
// they're hitting?
//
// Product-scoped wizard routes now put the product code in the URL
// (/portal/wizard/[product]/...), which means the URL alone would be
// enough to open (and PATCH) a product's wizard nobody paid for unless
// something checks ClientProduct. `status: 'active'` mirrors the
// Stripe-driven billing state on ClientProduct (see schema.prisma) — a
// cancelled subscription's row still exists but is not "contracted"
// anymore.
// =============================================================================

export async function isProductContracted(
  prisma: PrismaClient,
  clientId: string,
  productCode: string,
): Promise<boolean> {
  const row = await prisma.clientProduct.findFirst({
    where: { clientId, status: 'active', product: { code: productCode } },
    select: { id: true },
  });
  return row !== null;
}

// =============================================================================
// Fase 1 multi-instancia — la otra pregunta.
//
// Hasta aquí solo existía isProductContracted, que responde "¿este cliente
// tiene SEO?". Con varias contrataciones del mismo producto (SEO para dos
// webs, un chatbot por negocio) aparece una segunda pregunta que NO es la
// misma: "¿este cliente tiene SEO PARA ESTE SITIO?".
//
// La decisión, tomada en docs/plan-multi-instancia-fase-1.md, es no
// fusionarlas. Las dos son legítimas y se usan en sitios distintos:
//
//   isProductContracted        decide QUÉ SE VE    (pestaña, mosaico, menú)
//   resolveContractedInstance  decide QUÉ SE TOCA  (toda escritura)
//
// Una ruta que escriba y autorice con la primera es un fallo: con dos
// instancias, autorizaría por "tiene el producto" y luego escribiría sobre
// una instancia elegida arbitrariamente. Lo vigila un test estructural
// (tests/unit/product-instance-authorization.test.ts).
//
// Hoy esto todavía no cambia ningún comportamiento: mientras el checkout
// siga devolviendo 409 already_contracted, cada cliente tiene como mucho una
// instancia y esta función devuelve exactamente lo que devolvían los
// findFirst que ya había. Esa equivalencia es deliberada — ver "Lo que esta
// fase hace, y lo que deliberadamente no hace" en el plan.
// =============================================================================

export interface ContractedInstance {
  clientProductId: string;
  clientId: string;
  /** Aislamiento por tenant. Va aquí y no se re-consulta en cada llamante
   *  porque todo lo que se escribe colgando de una contratación lo necesita
   *  (la fila del perfil, su auditoría), y resolverlo aparte es cómo se
   *  cuela un null en una columna de tenant. */
  tenantId: string | null;
  /** El negocio/web del cliente al que pertenece. NULL cuando la contratación
   *  no declara sitio: el llamante que lo necesite resuelve al primario. */
  clientSiteId: string | null;
  code: string;
  tier: string;
  status: string;
}

export interface ResolveInstanceInput {
  clientId: string;
  productCode: string;
  /** El id de la contratación, normalmente desde la URL
   *  (/portal/<producto>/[clientProductId]). Omitirlo significa "la única que
   *  haya": con una instancia devuelve esa, con varias devuelve null en vez
   *  de elegir. Negarse es lo correcto — hoy el código que no lo pasa elige
   *  arbitrariamente y ni siquiera se entera. */
  clientProductId?: string | null;
}

export async function resolveContractedInstance(
  prisma: PrismaClient,
  { clientId, productCode, clientProductId }: ResolveInstanceInput,
): Promise<ContractedInstance | null> {
  // Sin id explícito hay que saber si hay ambigüedad, así que se piden dos:
  // si vuelven dos, es que no se puede decidir.
  const rows = await prisma.clientProduct.findMany({
    where: {
      ...(clientProductId ? { id: clientProductId } : {}),
      clientId,
      status: 'active',
      product: { code: productCode },
    },
    select: {
      id: true,
      clientId: true,
      clientSiteId: true,
      tenantId: true,
      status: true,
      product: { select: { code: true, tier: true } },
    },
    // Estable a propósito. El código anterior usaba findFirst SIN orderBy:
    // con dos filas, Postgres puede devolver una distinta entre dos llamadas
    // idénticas, y entonces la auditoría corre sobre una web y el artículo
    // se publica en la otra.
    orderBy: { subscribedAt: 'asc' },
    take: 2,
  });

  if (rows.length !== 1) return null;
  const row = rows[0];
  return {
    clientProductId: row.id,
    clientId: row.clientId,
    clientSiteId: row.clientSiteId,
    tenantId: row.tenantId,
    code: row.product.code,
    tier: row.product.tier,
    status: row.status,
  };
}

/**
 * WP-XX — statuses that grant access to a 'web' project's client-facing
 * surfaces (the brief and /portal/web) DURING the quote cycle, before the
 * ClientProduct reaches 'active'. Deliberately separate from
 * isProductContracted (which requires 'active' exclusively, unchanged,
 * used everywhere else in the portal): 'web' now goes through a free
 * 'quote_pending' request → operator quote → client acceptance → invoice
 * flow before any payment exists, and the client needs to reach the
 * brief/summary pages throughout that whole window, not just after
 * paying. Do not reuse this for any product other than 'web'. Shared
 * between canAccessWebProduct below, /portal/web/page.tsx, and
 * /api/portal/web-brief/route.ts so the three never silently drift apart.
 */
export const WEB_ACCESSIBLE_STATUSES = ['quote_pending', 'active', 'paused'];

export async function canAccessWebProduct(prisma: PrismaClient, clientId: string): Promise<boolean> {
  const row = await prisma.clientProduct.findFirst({
    where: { clientId, status: { in: WEB_ACCESSIBLE_STATUSES }, product: { code: 'web' } },
    select: { id: true },
  });
  return row !== null;
}

export interface ContractedProduct {
  code: string;
  tier: string;
}

/**
 * Every product this client currently has active, deduped by product code.
 *
 * Ese dedup nació como defensa contra data drift ("un cliente no debería
 * tener dos filas activas del mismo código"). Desde la fase 1 multi-instancia
 * esa premisa ya no vale: dos contrataciones del mismo código son el caso
 * normal, no una anomalía. El dedup se queda, pero por otra razón — su único
 * llamante es el selector del asistente (/portal/wizard), que enruta por
 * CÓDIGO (`/portal/wizard/seo`) y no tiene concepto de instancia: dos filas
 * darían dos tarjetas hacia la misma URL.
 *
 * Para "qué contrataciones tiene, una por una", usa listContractedInstances.
 */
export async function listContractedProducts(
  prisma: PrismaClient,
  clientId: string,
): Promise<ContractedProduct[]> {
  const rows = await prisma.clientProduct.findMany({
    where: { clientId, status: 'active' },
    select: { product: { select: { code: true, tier: true } } },
  });
  const byCode = new Map<string, ContractedProduct>();
  for (const row of rows) {
    if (!byCode.has(row.product.code)) {
      byCode.set(row.product.code, { code: row.product.code, tier: row.product.tier });
    }
  }
  return Array.from(byCode.values());
}

/**
 * Fase 1 multi-instancia — las contrataciones activas del cliente, UNA POR
 * UNA y con su sitio, sin deduplicar por código.
 *
 * Es lo que necesita cualquier superficie agrupada por negocio ("Clínica
 * Centro: chatbot, seo, reseñas"), frente a listContractedProducts, que
 * responde a la pregunta más pobre de "¿qué productos tiene?".
 *
 * Mismo orden estable que resolveContractedInstance, por el mismo motivo.
 */
export async function listContractedInstances(
  prisma: PrismaClient,
  clientId: string,
): Promise<ContractedInstance[]> {
  const rows = await prisma.clientProduct.findMany({
    where: { clientId, status: 'active' },
    select: {
      id: true,
      clientId: true,
      clientSiteId: true,
      tenantId: true,
      status: true,
      product: { select: { code: true, tier: true } },
    },
    orderBy: { subscribedAt: 'asc' },
  });
  return rows.map((row) => ({
    clientProductId: row.id,
    clientId: row.clientId,
    clientSiteId: row.clientSiteId,
    tenantId: row.tenantId,
    code: row.product.code,
    tier: row.product.tier,
    status: row.status,
  }));
}

// =============================================================================
// Multi-instancia — qué productos se pueden contratar más de una vez.
//
// UNA SOLA LISTA, porque la unicidad se impone en TRES capas y separarlas es
// el fallo fácil:
//
//   1. El índice único PARCIAL de ClientProduct, en Postgres. La garantía de
//      verdad. Su predicado excluye exactamente estos códigos.
//   2. createProductCheckoutSession (already_contracted), autoservicio.
//   3. activateClientProduct (reutilizar fila), alta de operador.
//
// Añadir un código aquí sin reescribir el predicado del índice hace que el
// insert reviente contra la base de datos; quitarlo del índice sin quitarlo
// aquí deja la puerta abierta en silencio. Lo vigila un test estructural
// (tests/unit/multi-instance-products.test.ts) que compara esta lista con el
// predicado de la última migración que lo tocó.
//
// 'web' lleva aquí desde 20260901120000_client_product_web_multiplicity, antes
// de que existiera este eje: cada proyecto web es independiente.
// 'seo' se añadió en la fase 2 (20260928090000_seo_multi_site): una
// contratación por web, con su propia propiedad de Search Console.
// =============================================================================

export const MULTI_INSTANCE_PRODUCT_CODES = ['web', 'seo'] as const;

export function isMultiInstanceProduct(productCode: string): boolean {
  return (MULTI_INSTANCE_PRODUCT_CODES as readonly string[]).includes(productCode);
}
