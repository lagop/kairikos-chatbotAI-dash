// =============================================================================
// WP-16 — unit tests for src/lib/client-product-access.ts.
// =============================================================================

import { describe, it, expect, vi } from 'vitest';
import { isProductContracted, listContractedProducts, canAccessWebProduct } from '@/lib/client-product-access';

function makePrisma(clientProduct: { findFirst?: unknown; findMany?: unknown }) {
  return {
    clientProduct: {
      findFirst: vi.fn().mockResolvedValue(clientProduct.findFirst ?? null),
      findMany: vi.fn().mockResolvedValue(clientProduct.findMany ?? []),
    },
  } as never;
}

describe('isProductContracted', () => {
  it('returns true when an active ClientProduct row exists', async () => {
    const prisma = makePrisma({ findFirst: { id: 'cp1' } });
    await expect(isProductContracted(prisma, 'c1', 'chatbot')).resolves.toBe(true);
  });

  it('returns false when no active ClientProduct row exists', async () => {
    const prisma = makePrisma({ findFirst: null });
    await expect(isProductContracted(prisma, 'c1', 'web')).resolves.toBe(false);
  });

  it('scopes the query by clientId, status=active, and product.code', async () => {
    const prisma = makePrisma({ findFirst: null });
    await isProductContracted(prisma, 'c1', 'web');
    expect(prisma.clientProduct.findFirst).toHaveBeenCalledWith({
      where: { clientId: 'c1', status: 'active', product: { code: 'web' } },
      select: { id: true },
    });
  });
});

describe('canAccessWebProduct', () => {
  it('returns true when the web ClientProduct is quote_pending', async () => {
    const prisma = makePrisma({ findFirst: { id: 'cp1' } });
    await expect(canAccessWebProduct(prisma, 'c1')).resolves.toBe(true);
  });

  it('returns false when there is no web ClientProduct row at all', async () => {
    const prisma = makePrisma({ findFirst: null });
    await expect(canAccessWebProduct(prisma, 'c1')).resolves.toBe(false);
  });

  it('scopes the query by clientId, status in [quote_pending, active, paused], and product.code=web', async () => {
    const prisma = makePrisma({ findFirst: null });
    await canAccessWebProduct(prisma, 'c1');
    expect(prisma.clientProduct.findFirst).toHaveBeenCalledWith({
      where: { clientId: 'c1', status: { in: ['quote_pending', 'active', 'paused'] }, product: { code: 'web' } },
      select: { id: true },
    });
  });
});

describe('listContractedProducts', () => {
  it('returns every distinct contracted product code + tier', async () => {
    const prisma = makePrisma({
      findMany: [
        { product: { code: 'chatbot', tier: 'pro' } },
        { product: { code: 'web', tier: 'standard' } },
      ],
    });
    const result = await listContractedProducts(prisma, 'c1');
    expect(result).toEqual([
      { code: 'chatbot', tier: 'pro' },
      { code: 'web', tier: 'standard' },
    ]);
  });

  it('dedupes by product code (data-drift defense)', async () => {
    const prisma = makePrisma({
      findMany: [
        { product: { code: 'chatbot', tier: 'pro' } },
        { product: { code: 'chatbot', tier: 'pro' } },
      ],
    });
    const result = await listContractedProducts(prisma, 'c1');
    expect(result).toEqual([{ code: 'chatbot', tier: 'pro' }]);
  });

  it('returns an empty list when the client has no active products', async () => {
    const prisma = makePrisma({ findMany: [] });
    await expect(listContractedProducts(prisma, 'c1')).resolves.toEqual([]);
  });
});
