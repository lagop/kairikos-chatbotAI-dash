import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { countActiveSubscriptionsForProduct } from '@/lib/stripe-catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/portal/settings/products/[productId]/impact
 *
 * Read-only — how many clients are actively subscribed to this tier
 * right now. Shown before confirming a reprice so the operator
 * understands that these subscribers keep their current price. No TOTP
 * step-up required — this doesn't mutate anything.
 */
export async function GET(req: NextRequest, { params }: { params: { productId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const product = await prisma.product.findUnique({ where: { id: params.productId }, select: { id: true } });
  if (!product) return NextResponse.json({ error: 'product_not_found' }, { status: 404 });

  const activeSubscriptions = await countActiveSubscriptionsForProduct(params.productId);
  return NextResponse.json({ activeSubscriptions });
}
