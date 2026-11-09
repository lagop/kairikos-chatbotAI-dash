import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { movePremiumQuote, PREMIUM_QUOTE_STATUSES } from '@/lib/premium-quoter';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 09/11/2026 — mover un presupuesto de Web Premium por la bandeja. Las
// transiciones permitidas están en lib/premium-quoter.ts.

const BodySchema = z.object({ status: z.enum(PREMIUM_QUOTE_STATUSES) });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  try {
    const operator = await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
    const result = await movePremiumQuote(prisma, id, body.data.status, operator?.email ?? null);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === 'not_found' ? 404 : 409 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('premium_quoter.move_failed', err, { id });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
