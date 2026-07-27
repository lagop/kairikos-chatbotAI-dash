import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';

const IdSchema = z.string().uuid();
const StatusSchema = z.enum(['active', 'paused', 'cancelled', 'past_due']);

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  if (!IdSchema.safeParse(params.id).success) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const body = z.object({ status: StatusSchema }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  const current = await prisma.clientProduct.findUnique({ where: { id: params.id } });
  if (!current) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const status = body.data.status;
  const row = await prisma.clientProduct.update({
    where: { id: params.id },
    data: {
      status,
      cancelledAt: status === 'cancelled' ? new Date() : null,
      changedBy: auth.operatorId,
    },
    include: { product: true, client: { select: { id: true, name: true, companyName: true, email: true } }, auditLogs: { orderBy: { changedAt: 'desc' }, take: 20 } },
  });
  return NextResponse.json(row);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
