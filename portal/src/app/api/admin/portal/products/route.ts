import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const rows = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: { priceCents: 'asc' },
    select: { id: true, stripePriceId: true, name: true, tier: true, priceCents: true, currency: true, features: true, isActive: true, createdAt: true },
  });
  return NextResponse.json(rows);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
