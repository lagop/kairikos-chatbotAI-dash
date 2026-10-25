import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { createFormToken } from './website-form';
import { slugify } from './website-publish';
import { isShareToken } from './prospecting-share';
import type { WebDraftCopy } from './web-draft-ai';
import { DEFAULT_WEB_DRAFT_OFFER, type WebDraftOffer, type WebDraftPurchaseCta } from './web-draft-html';
import { logError } from './observability';

// =============================================================================
// 25/10/2026 — comprar la web sin llamada, desde la página del borrador.
//
// Hasta hoy 'web' solo se vendía por presupuesto (WebQuote): el visitante
// pedía, el operador presupuestaba, el visitante aceptaba y pagaba una
// factura. Con eso, la línea que el plan de negocio cuenta como más de un
// tercio de los ingresos del año 1 exigía siempre una conversación.
//
// Por qué la compra directa nace SOLO desde un borrador y no en /web/:
// - El borrador es lo que hace honesto un precio cerrado. Quien pulsa «La
//   quiero» ya ha visto SU web —su nombre, sus servicios, su plantilla—, así
//   que sabe exactamente qué compra por 799 €. En /web/, sin borrador, el
//   contenido aún no existe y «a medida» sigue siendo la descripción correcta.
// - Por eso Product.selfServeEligible de 'web' NO se toca: es el que decide
//   los botones de kairikos.com (/api/public/catalogo) y la lista de
//   /empezar, y ponerlo a true cambiaría «Pedir presupuesto» por «Contratar»
//   en toda la web pública. La puerta de esta compra es otra: un testigo de
//   borrador válido + hueco en el tope del mes.
//
// El tope existe porque cada web son horas de trabajo humano. Se cuenta lo
// pagado este mes más los pagos abiertos en las últimas 24 h (un Checkout de
// Stripe caduca a las 24 h): sin lo segundo, cinco personas abriendo el pago
// a la vez con un hueco libre se lo llevarían las cinco.
//
// Al pagar, el sitio del cliente nace ya con el contenido del borrador
// (createClientWebsiteFromDraft), alojado por nosotros: la oferta incluye
// dominio y alojamiento el primer año. El operador no tiene que buscar de qué
// borrador venía: lo encuentra en la ficha del cliente.
// =============================================================================

export const WEB_SALES_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-000000000003';

/** El de la fase 1 del plan de negocio: 4 webs al mes. */
export const DEFAULT_WEB_SELF_SERVE_MONTHLY_CAP = 4;
export const MIN_WEB_SELF_SERVE_MONTHLY_CAP = 0;
export const MAX_WEB_SELF_SERVE_MONTHLY_CAP = 50;

/** Lo que tarda en caducar un Checkout de Stripe: un pago abierto hace más
 *  de esto ya no puede completarse, así que deja de ocupar hueco. */
export const PENDING_CHECKOUT_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function getWebSelfServeMonthlyCap(prisma: PrismaClient): Promise<number> {
  const row = await prisma.webSalesSettings.findUnique({ where: { id: WEB_SALES_SETTINGS_SINGLETON_ID } });
  return row ? row.selfServeMonthlyCap : DEFAULT_WEB_SELF_SERVE_MONTHLY_CAP;
}

export async function updateWebSelfServeMonthlyCap(
  prisma: PrismaClient,
  cap: number,
  actorEmail: string | null,
): Promise<void> {
  await prisma.webSalesSettings.upsert({
    where: { id: WEB_SALES_SETTINGS_SINGLETON_ID },
    create: { id: WEB_SALES_SETTINGS_SINGLETON_ID, selfServeMonthlyCap: cap, updatedBy: actorEmail },
    update: { selfServeMonthlyCap: cap, updatedBy: actorEmail },
  });
}

/** Primer instante del mes en UTC. Limitación aceptada: el mes cambia a las
 *  00:00 UTC, una hora antes que en la Península y a la misma hora que en
 *  Canarias en invierno. Para un tope de webs al mes no importa. */
export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export interface WebSelfServeUsage {
  /** Webs pagadas por autoservicio este mes. */
  sold: number;
  /** Pagos de web abiertos en las últimas 24 h que aún pueden completarse. */
  pending: number;
}

/** Pura: ¿queda hueco? Un tope de 0 apaga la compra. */
export function webSelfServeCapacity(cap: number, usage: WebSelfServeUsage): { available: boolean; remaining: number } {
  const remaining = Math.max(0, cap - usage.sold - usage.pending);
  return { available: cap > 0 && remaining > 0, remaining };
}

export async function countWebSelfServeUsage(prisma: PrismaClient, now: Date): Promise<WebSelfServeUsage> {
  const [sold, pending] = await Promise.all([
    // 'checkout_completed' solo lo escribe la activación de un Checkout de
    // Stripe (activateClientProductFromCheckout). Las webs por presupuesto
    // se activan con 'web_quote_paid' y no cuentan: el tope es del
    // autoservicio, no de toda la producción de webs.
    prisma.clientProductAudit.count({
      where: { action: 'checkout_completed', product: { code: 'web' }, changedAt: { gte: startOfMonthUtc(now) } },
    }),
    prisma.clientProduct.count({
      where: {
        status: 'pending_payment',
        product: { code: 'web' },
        auditLogs: {
          some: {
            action: 'checkout_started',
            changedAt: { gte: new Date(now.getTime() - PENDING_CHECKOUT_WINDOW_MS) },
          },
        },
      },
    }),
  ]);
  return { sold, pending };
}

// ---------------------------------------------------------------------------
// De qué borrador viene la compra
// ---------------------------------------------------------------------------

export type WebDraftKind = 'public' | 'prospecting';

export interface WebDraftSeed {
  kind: WebDraftKind;
  token: string;
  businessName: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  primaryType: string | null;
  themeKey: string;
  copy: WebDraftCopy;
}

/** Mismo criterio que /mi-web: lo que dejó solo cuenta como teléfono si lo es. */
function phoneOrNull(contact: string): string | null {
  return /^[+0-9][0-9 ]{7,}$/.test(contact) ? contact : null;
}

/**
 * El borrador detrás de un testigo, venga de kairikos.com (/mi-web) o de la
 * prospección de Kairikos (/borrador).
 *
 * Los de prospección, solo si el prospecto es de una cuenta INTERNA: el
 * barrido de borradores (web-draft-sweep.ts) también genera para prospectos
 * de campañas de clientes, y venderle una web nuestra a un prospecto de otro
 * negocio no es algo que ese negocio haya pedido.
 */
export async function resolveWebDraft(prisma: PrismaClient, token: string): Promise<WebDraftSeed | null> {
  if (!isShareToken(token)) return null;

  const request = await prisma.publicDraftRequest.findUnique({
    where: { token },
    select: { businessName: true, city: true, contact: true, primaryType: true, themeKey: true, copy: true },
  });
  if (request) {
    return {
      kind: 'public',
      token,
      businessName: request.businessName,
      phone: phoneOrNull(request.contact),
      address: null,
      city: request.city,
      primaryType: request.primaryType,
      themeKey: request.themeKey,
      copy: request.copy as unknown as WebDraftCopy,
    };
  }

  const draft = await prisma.prospectingWebDraft.findUnique({
    where: { shareToken: token },
    select: {
      copy: true,
      themeKey: true,
      client: { select: { isInternal: true } },
      lead: { select: { contactName: true, contactPhone: true, summary: true, primaryType: true, searchLocation: true } },
    },
  });
  if (!draft || !draft.client.isInternal || !draft.lead.contactName) return null;
  return {
    kind: 'prospecting',
    token,
    businessName: draft.lead.contactName,
    phone: draft.lead.contactPhone,
    address: draft.lead.summary?.replace(/^Negocio encontrado en\s*/i, '').replace(/\.$/, '') ?? null,
    city: draft.lead.searchLocation,
    primaryType: draft.lead.primaryType,
    themeKey: draft.themeKey,
    copy: draft.copy as unknown as WebDraftCopy,
  };
}

// ---------------------------------------------------------------------------
// ¿Se puede comprar desde este borrador ahora mismo?
// ---------------------------------------------------------------------------

export interface WebPurchaseProduct {
  id: string;
  setupFeeCents: number;
  currency: string;
}

export type WebDraftPurchase =
  | { available: true; product: WebPurchaseProduct; seed: WebDraftSeed }
  | { available: false; reason: 'draft_not_found' | 'product_unavailable' | 'sold_out' };

/** La regla entera, en un sitio: la usan la página del borrador, /empezar,
 *  el alta y el checkout. El checkout es la que manda — las demás solo
 *  deciden qué botón enseñar. */
export async function getWebDraftPurchase(prisma: PrismaClient, token: string, now: Date): Promise<WebDraftPurchase> {
  const seed = await resolveWebDraft(prisma, token);
  if (!seed) return { available: false, reason: 'draft_not_found' };

  const product = await prisma.product.findFirst({
    where: { code: 'web', isActive: true, kind: 'plan' },
    select: { id: true, setupFeeCents: true, currency: true, stripeSetupPriceId: true },
  });
  // Sin precio de alta en Stripe no hay nada que cobrar: mejor el botón de
  // llamada que un pago que falla después de crear la cuenta.
  if (!product || product.setupFeeCents <= 0 || !product.stripeSetupPriceId) {
    return { available: false, reason: 'product_unavailable' };
  }

  const [cap, usage] = await Promise.all([getWebSelfServeMonthlyCap(prisma), countWebSelfServeUsage(prisma, now)]);
  if (!webSelfServeCapacity(cap, usage).available) return { available: false, reason: 'sold_out' };

  return {
    available: true,
    product: { id: product.id, setupFeeCents: product.setupFeeCents, currency: product.currency },
    seed,
  };
}

/** Adónde lleva «La quiero». /empezar resuelve el producto y el borrador. */
export function webDraftPurchasePath(token: string): string {
  return `/empezar?producto=web&borrador=${encodeURIComponent(token)}`;
}

/** «799 €», como se escribe en España: sin decimales cuando son cero. */
export function formatEurosLabel(cents: number): string {
  const euros = cents / 100;
  return `${new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: Number.isInteger(euros) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(euros)} €`;
}

/**
 * Pura: qué enseña la página del borrador según lo que dijo getWebDraftPurchase.
 * - Hay hueco → «La quiero · 799 €», con el precio del catálogo.
 * - Tope lleno → «Reservar una llamada».
 * - Cualquier otro motivo (borrador de un prospecto de otro cliente, web sin
 *   precio en Stripe) → nada: la página queda como estaba.
 */
export function purchaseCtaFor(
  purchase: WebDraftPurchase | null,
  token: string,
  demoUrl: string,
): { cta: WebDraftPurchaseCta | null; offer: WebDraftOffer | undefined } {
  if (purchase?.available) {
    const price = formatEurosLabel(purchase.product.setupFeeCents);
    return {
      cta: { kind: 'buy', href: webDraftPurchasePath(token), priceLabel: price },
      offer: { priceLabel: `${price}, pago único`, daysLabel: DEFAULT_WEB_DRAFT_OFFER.daysLabel },
    };
  }
  if (purchase && !purchase.available && purchase.reason === 'sold_out') {
    return { cta: { kind: 'call', href: demoUrl }, offer: undefined };
  }
  return { cta: null, offer: undefined };
}

// ---------------------------------------------------------------------------
// Al pagar: el sitio del cliente, ya con el contenido del borrador
// ---------------------------------------------------------------------------

/**
 * Crea el ClientWebsite de la unidad recién pagada con lo que el cliente vio
 * en el borrador. Copiado, no referenciado — mismo criterio que el alta de
 * operador (POST /api/admin/portal/websites): desde aquí, su web y el
 * borrador tienen vidas distintas.
 *
 * Alojado por nosotros ('kairikos'): la oferta incluye dominio y alojamiento
 * el primer año, así que el destino por defecto del alta de operador (SFTP en
 * SU servidor) sería el equivocado.
 *
 * Nunca lanza: corre después de cobrar, y un fallo aquí no puede deshacer un
 * pago. Si falla, queda un aviso y el operador crea el sitio a mano como
 * siempre.
 */
export async function createClientWebsiteFromDraft(
  prisma: PrismaClient,
  params: { clientProductId: string; clientId: string; tenantId: string | null; seed: WebDraftSeed },
): Promise<{ ok: true; websiteId: string } | { ok: false }> {
  const { seed } = params;
  try {
    const existing = await prisma.clientWebsite.findUnique({
      where: { clientProductId: params.clientProductId },
      select: { id: true },
    });
    if (existing) return { ok: true, websiteId: existing.id };

    const website = await prisma.$transaction(async (tx) => {
      const row = await tx.clientWebsite.create({
        data: {
          clientId: params.clientId,
          clientProductId: params.clientProductId,
          tenantId: params.tenantId,
          businessName: seed.businessName,
          phone: seed.phone,
          address: seed.address,
          city: seed.city,
          primaryType: seed.primaryType,
          themeKey: seed.themeKey,
          copy: seed.copy as unknown as object,
          status: 'draft',
          formToken: createFormToken(),
          publishTarget: 'kairikos',
          // Con el id detrás, como en el alta de operador: dos negocios con el
          // mismo nombre no chocan.
          slug: `${slugify(seed.businessName)}-${Date.now().toString(36).slice(-4)}`,
        },
      });
      await tx.clientWebsiteAudit.create({
        data: {
          websiteId: row.id,
          clientId: row.clientId,
          tenantId: row.tenantId,
          action: 'created',
          // El testigo NO se guarda: es la llave de un enlace público. Basta
          // con de qué tipo de borrador venía.
          after: { fromDraft: seed.kind, themeKey: row.themeKey, source: 'self_serve_checkout' },
          actorType: 'system',
          actorEmail: 'stripe:checkout.session.completed',
        },
      });
      return row;
    });
    return { ok: true, websiteId: website.id };
  } catch (err) {
    logError('web_self_serve.website_from_draft_failed', err, { clientProductId: params.clientProductId }, 'warn');
    return { ok: false };
  }
}
