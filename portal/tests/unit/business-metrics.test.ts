// =============================================================================
// A9 — unit tests de las métricas del negocio.
//
// La primera cobertura de este lib, y llega por un motivo concreto: el panel
// enseñaba 900 €/mes de ingresos recurrentes que no existían. Eran los cuatro
// productos "activos" de la cuenta de pruebas, que nadie paga.
//
// Lo que se fija:
//
// 1. Que las cuentas internas se caigan del DINERO —ingresos, clientes,
//    bajas— y que NO se caigan del embudo. Las dos mitades de esa frase se
//    fijan aquí, porque cada una se rompe al "completar" la otra por
//    simetría: el MRR de una cuenta nuestra miente porque nadie lo paga, y
//    su prospección no miente porque es la nuestra.
// 2. Que el MRR salga de lo que se cobra y no de la tarifa cuando hay
//    suscripción — un descuento o un precio viejo facturan lo suyo.
// 3. Que sin clientes no se invente una tasa de bajas del 0 %.
//
// El prisma de aquí es un objeto a mano y no un mock de módulo:
// loadBusinessMetrics lo recibe por parámetro, así que no hace falta más.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { loadBusinessMetrics } from '@/lib/business-metrics';
import type { PrismaClient } from '@prisma/client';

function fakePrisma(over: {
  activos?: unknown[];
  cancelados?: number;
  leads?: number;
} = {}) {
  const calls: Record<string, unknown[]> = { clientProductFindMany: [], clientProductCount: [], leadCount: [] };
  const prisma = {
    clientProduct: {
      findMany: vi.fn(async (args: unknown) => {
        calls.clientProductFindMany.push(args);
        return over.activos ?? [];
      }),
      count: vi.fn(async (args: unknown) => {
        calls.clientProductCount.push(args);
        return over.cancelados ?? 0;
      }),
    },
    lead: {
      count: vi.fn(async (args: unknown) => {
        calls.leadCount.push(args);
        return over.leads ?? 0;
      }),
    },
    prospectingWebDraft: { count: vi.fn(async () => 0) },
    publicDraftRequest: { count: vi.fn(async () => 0) },
  } as unknown as PrismaClient;
  return { prisma, calls };
}

const PRODUCTO = { code: 'recall', tier: 'solo', priceCents: 14900 };

describe('loadBusinessMetrics — las cuentas internas no cuentan', () => {
  it('filtra las internas al sumar los ingresos recurrentes', async () => {
    const { prisma, calls } = fakePrisma();
    await loadBusinessMetrics(prisma);

    expect(calls.clientProductFindMany[0]).toMatchObject({
      where: { status: 'active', client: { isInternal: false } },
    });
  });

  it('las filtra también en las bajas: si no, el churn sale sobre un total que no es', async () => {
    const { prisma, calls } = fakePrisma();
    await loadBusinessMetrics(prisma);

    expect(calls.clientProductCount[0]).toMatchObject({
      where: { status: 'cancelled', client: { isInternal: false } },
    });
  });

  // ===========================================================================
  // Y el reverso, que es el que se rompe solo si alguien "completa" el filtro
  // de arriba por simetría: el embudo NO se filtra.
  //
  // El MRR de una cuenta nuestra miente, porque nadie lo paga. Su prospección
  // no miente: es LA prospección, la que hacemos para encontrar clientes. Hoy
  // la única campaña que existe cuelga de nuestra propia cuenta, así que
  // filtrar por interna dejaría el embudo entero a cero el mismo día que se
  // marca — y el embudo es la mitad de la revisión semanal.
  // ===========================================================================
  it('el embudo NO se filtra: la prospección de una cuenta nuestra es la nuestra', async () => {
    const { prisma, calls } = fakePrisma();
    await loadBusinessMetrics(prisma);

    expect(calls.leadCount).toHaveLength(3);
    for (const args of calls.leadCount) {
      expect(args).toMatchObject({ where: { source: 'outbound' } });
      expect(JSON.stringify(args)).not.toContain('isInternal');
    }
  });
});

describe('loadBusinessMetrics — de dónde sale el MRR', () => {
  it('manda lo que se cobra, no la tarifa, cuando hay suscripción', async () => {
    const { prisma } = fakePrisma({
      activos: [
        // Tarifa 149 €, pero este cliente tiene un precio viejo de 99 €.
        { clientId: 'c1', product: PRODUCTO, subscription: { amountCents: 9900, status: 'active' } },
      ],
    });
    const metrics = await loadBusinessMetrics(prisma);
    expect(metrics.mrrTotalCents).toBe(9900);
  });

  it('sin suscripción cae a la tarifa del catálogo', async () => {
    const { prisma } = fakePrisma({ activos: [{ clientId: 'c1', product: PRODUCTO, subscription: null }] });
    const metrics = await loadBusinessMetrics(prisma);
    expect(metrics.mrrTotalCents).toBe(14900);
  });

  it('una suscripción cancelada no factura: vuelve a la tarifa', async () => {
    const { prisma } = fakePrisma({
      activos: [{ clientId: 'c1', product: PRODUCTO, subscription: { amountCents: 9900, status: 'canceled' } }],
    });
    const metrics = await loadBusinessMetrics(prisma);
    expect(metrics.mrrTotalCents).toBe(14900);
  });

  it('cuenta clientes, no contratos: dos productos del mismo cliente son un cliente', async () => {
    const { prisma } = fakePrisma({
      activos: [
        { clientId: 'c1', product: PRODUCTO, subscription: null },
        { clientId: 'c1', product: { code: 'reviews', tier: 'basic', priceCents: 9900 }, subscription: null },
      ],
    });
    const metrics = await loadBusinessMetrics(prisma);
    expect(metrics.clientesConAlgoActivo).toBe(1);
    expect(metrics.clientesMultiproducto).toBe(1);
    expect(metrics.mrrTotalCents).toBe(24800);
  });
});

describe('loadBusinessMetrics — lo que no se inventa', () => {
  it('sin clientes no hay tasa de bajas, y no es cero', async () => {
    const { prisma } = fakePrisma();
    const metrics = await loadBusinessMetrics(prisma);
    expect(metrics.churnMensual).toBeNull();
    expect(metrics.ratioMultiproducto).toBeNull();
  });

  it('con clientes y bajas sí, y sale sobre el total de los dos', async () => {
    const { prisma } = fakePrisma({
      activos: [{ clientId: 'c1', product: PRODUCTO, subscription: null }],
      cancelados: 1,
    });
    const metrics = await loadBusinessMetrics(prisma);
    expect(metrics.churnMensual).toBe(0.5);
  });
});
