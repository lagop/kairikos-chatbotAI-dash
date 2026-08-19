import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';

export async function GET(_req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') return NextResponse.json([]);

  const rows = await prisma.clientProduct.findMany({
    where: { clientId: resolved.clientId, status: { in: ['active', 'paused'] } },
    orderBy: { subscribedAt: 'asc' },
    select: { id: true, status: true, subscribedAt: true, product: { select: { id: true, name: true, tier: true, features: true } } },
  });
  return NextResponse.json(rows);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
