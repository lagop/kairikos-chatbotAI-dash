// =============================================================================
// Fase 1 multi-instancia — resolveContractedInstance / listContractedInstances.
//
// Lo que de verdad se prueba aquí es la propiedad que hace segura la fase:
// con UNA sola instancia, resolver sin pasar clientProductId devuelve
// exactamente lo que devolvía el findFirst de siempre. Si eso se rompiera,
// la fase 1 habría cambiado comportamiento, que es justo lo que no debe hacer.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import {
  resolveContractedInstance,
  listContractedInstances,
} from '@/lib/client-product-access';

const row = (id: string, code = 'seo', siteId: string | null = 'site_1') => ({
  id,
  clientId: 'c1',
  clientSiteId: siteId,
  status: 'active',
  product: { code, tier: 'standard' },
});

function makePrisma(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { prisma: { clientProduct: { findMany } } as never, findMany };
}

describe('resolveContractedInstance', () => {
  it('con una sola contratación, resuelve sin necesidad de id', async () => {
    const { prisma } = makePrisma([row('cp1')]);
    await expect(
      resolveContractedInstance(prisma, { clientId: 'c1', productCode: 'seo' }),
    ).resolves.toEqual({
      clientProductId: 'cp1',
      clientId: 'c1',
      clientSiteId: 'site_1',
      code: 'seo',
      tier: 'standard',
      status: 'active',
    });
  });

  it('devuelve null si no hay ninguna', async () => {
    const { prisma } = makePrisma([]);
    await expect(
      resolveContractedInstance(prisma, { clientId: 'c1', productCode: 'seo' }),
    ).resolves.toBeNull();
  });

  it('con DOS y sin id, se niega en vez de elegir', async () => {
    // Éste es el fallo latente que la fase 1 cierra: el código anterior
    // hacía findFirst sin orderBy y cogía una arbitraria.
    const { prisma } = makePrisma([row('cp1'), row('cp2', 'seo', 'site_2')]);
    await expect(
      resolveContractedInstance(prisma, { clientId: 'c1', productCode: 'seo' }),
    ).resolves.toBeNull();
  });

  it('con id explícito, fija la consulta al cliente Y al código del producto', async () => {
    // Que el id venga de la URL no puede bastar: si solo se filtrara por id,
    // el de otro cliente resolvería. Mismo patrón que /portal/web/[clientProductId].
    const { prisma, findMany } = makePrisma([row('cp2')]);
    await resolveContractedInstance(prisma, {
      clientId: 'c1',
      productCode: 'seo',
      clientProductId: 'cp2',
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'cp2',
          clientId: 'c1',
          status: 'active',
          product: { code: 'seo' },
        },
      }),
    );
  });

  it('pide un orden estable y se queda en dos filas', async () => {
    const { prisma, findMany } = makePrisma([row('cp1')]);
    await resolveContractedInstance(prisma, { clientId: 'c1', productCode: 'seo' });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { subscribedAt: 'asc' }, take: 2 }),
    );
  });

  it('un clientProductId vacío no se cuela como filtro', async () => {
    const { prisma, findMany } = makePrisma([row('cp1')]);
    await resolveContractedInstance(prisma, {
      clientId: 'c1',
      productCode: 'seo',
      clientProductId: '',
    });
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('id');
  });

  it('traslada el sitio nulo tal cual, sin inventarse el primario', async () => {
    // Resolver al primario es trabajo del llamante que lo necesite, no de
    // esta función: aquí NULL significa "no lo declara".
    const { prisma } = makePrisma([row('cp1', 'seo', null)]);
    const found = await resolveContractedInstance(prisma, { clientId: 'c1', productCode: 'seo' });
    expect(found?.clientSiteId).toBeNull();
  });
});

describe('listContractedInstances', () => {
  it('NO deduplica por código: dos webs son dos filas', async () => {
    const { prisma } = makePrisma([row('cp1'), row('cp2', 'seo', 'site_2')]);
    const list = await listContractedInstances(prisma, 'c1');
    expect(list.map((i) => i.clientProductId)).toEqual(['cp1', 'cp2']);
    expect(list.map((i) => i.clientSiteId)).toEqual(['site_1', 'site_2']);
  });

  it('solo las activas, en orden estable', async () => {
    const { prisma, findMany } = makePrisma([]);
    await listContractedInstances(prisma, 'c1');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'c1', status: 'active' },
        orderBy: { subscribedAt: 'asc' },
      }),
    );
  });
});
