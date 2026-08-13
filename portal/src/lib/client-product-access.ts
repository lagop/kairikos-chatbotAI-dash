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

export interface ContractedProduct {
  code: string;
  tier: string;
}

/**
 * Every product this client currently has active, deduped by product
 * code (a client should not have two active rows for the same code, but
 * this defends against the data drift rather than surfacing duplicates
 * in the wizard selector).
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
