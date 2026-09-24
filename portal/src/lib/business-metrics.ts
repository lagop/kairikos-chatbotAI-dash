import 'server-only';
import type { PrismaClient } from '@prisma/client';

// =============================================================================
// A9 — las métricas del negocio propio, no las de un cliente.
//
// Es la revisión semanal de 15 minutos del plan: ingresos recurrentes, de qué
// productos vienen, cuánta gente se va y cómo va el embudo comercial. Hoy eso
// vive repartido entre Stripe, la base de datos y la cabeza del operador.
//
// El MRR sale de las suscripciones activas y NO de la tabla de precios: lo
// que factura un cliente es lo que tiene contratado, no lo que dice la
// tarifa. La diferencia aparece en cuanto hay un descuento o una tarifa vieja.
//
// Todo son consultas de lectura. Se calcula al pintar la página y no se
// precalcula nada: con decenas de clientes sobra, y una tabla de métricas
// precalculadas es una cosa más que puede quedarse vieja sin avisar.
// =============================================================================

export interface ProductMrrRow {
  productCode: string;
  tier: string;
  clientes: number;
  mrrCents: number;
}

export interface FunnelRow {
  etapa: string;
  valor: number;
  /** Lo que significa la etapa, para que la cifra no haya que interpretarla. */
  detalle: string;
}

export interface BusinessMetrics {
  mrrTotalCents: number;
  clientesConAlgoActivo: number;
  porProducto: ProductMrrRow[];
  /** Bajas de los últimos 30 días y su proporción sobre el total activo. */
  bajas30d: number;
  churnMensual: number | null;
  embudo: FunnelRow[];
  /** Cuántos clientes tienen 2 o más productos: el objetivo del 40 % del plan. */
  clientesMultiproducto: number;
  ratioMultiproducto: number | null;
}

export async function loadBusinessMetrics(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<BusinessMetrics> {
  const hace30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [activos, cancelados, prospectos, contactados, respondieron, borradores, peticionesPublicas] =
    await Promise.all([
      prisma.clientProduct.findMany({
        where: { status: 'active' },
        select: {
          clientId: true,
          product: { select: { code: true, tier: true, priceCents: true } },
          subscription: { select: { amountCents: true, status: true } },
        },
      }),
      prisma.clientProduct.count({ where: { status: 'cancelled', changedAt: { gte: hace30 } } }),
      prisma.lead.count({ where: { source: 'outbound' } }),
      prisma.lead.count({ where: { source: 'outbound', contactedAt: { not: null } } }),
      prisma.lead.count({ where: { source: 'outbound', repliedAt: { not: null } } }),
      prisma.prospectingWebDraft.count(),
      prisma.publicDraftRequest.count(),
    ]);

  const porProductoMap = new Map<string, ProductMrrRow>();
  const clientes = new Set<string>();
  const productosPorCliente = new Map<string, number>();
  let mrrTotalCents = 0;

  for (const row of activos) {
    clientes.add(row.clientId);
    productosPorCliente.set(row.clientId, (productosPorCliente.get(row.clientId) ?? 0) + 1);

    // Lo que de verdad se cobra manda sobre la tarifa. Una suscripción con
    // descuento o con un precio viejo factura lo suyo, no lo que diga hoy el
    // catálogo.
    const cents =
      (row.subscription && ['active', 'trialing', 'past_due'].includes(row.subscription.status)
        ? row.subscription.amountCents
        : row.product.priceCents) ?? 0;
    mrrTotalCents += cents;

    const key = `${row.product.code}|${row.product.tier}`;
    const actual = porProductoMap.get(key);
    if (actual) {
      actual.clientes += 1;
      actual.mrrCents += cents;
    } else {
      porProductoMap.set(key, {
        productCode: row.product.code,
        tier: row.product.tier,
        clientes: 1,
        mrrCents: cents,
      });
    }
  }

  const multiproducto = [...productosPorCliente.values()].filter((n) => n >= 2).length;

  return {
    mrrTotalCents,
    clientesConAlgoActivo: clientes.size,
    porProducto: [...porProductoMap.values()].sort((a, b) => b.mrrCents - a.mrrCents),
    bajas30d: cancelados,
    // Sin clientes no hay tasa: enseñar "0 % de bajas" cuando no hay nadie es
    // mentir por omisión, igual que en summarizeProspecting.
    churnMensual: clientes.size === 0 ? null : cancelados / (clientes.size + cancelados),
    clientesMultiproducto: multiproducto,
    ratioMultiproducto: clientes.size === 0 ? null : multiproducto / clientes.size,
    embudo: [
      { etapa: 'Prospectos encontrados', valor: prospectos, detalle: 'negocios que ha traído el barrido' },
      { etapa: 'Con borrador de web', valor: borradores, detalle: 'listos para enseñar en la llamada' },
      { etapa: 'Contactados', valor: contactados, detalle: 'con primer contacto registrado' },
      { etapa: 'Respondieron', valor: respondieron, detalle: 'contestaron al contacto' },
      {
        etapa: 'Pidieron su web en kairikos.com',
        valor: peticionesPublicas,
        detalle: 'entraron ellos solos por el formulario público',
      },
      { etapa: 'Clientes con algo activo', valor: clientes.size, detalle: 'pagando al menos un producto' },
    ],
  };
}
