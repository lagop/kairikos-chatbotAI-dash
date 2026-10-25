import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import {
  countWebSelfServeUsage,
  getWebSelfServeMonthlyCap,
  updateWebSelfServeMonthlyCap,
  MIN_WEB_SELF_SERVE_MONTHLY_CAP,
  MAX_WEB_SELF_SERVE_MONTHLY_CAP,
} from '@/lib/web-self-serve';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// 25/10/2026 — GET/POST /api/admin/portal/settings/web
//
// El tope de webs vendidas al mes por autoservicio desde el borrador. Mismo
// molde que settings/seo: solo operador y sin TOTP, porque es un ajuste de
// capacidad, no una credencial — lo peor de un valor equivocado es vender
// más o menos webs de las que caben en la agenda.
// =============================================================================

export async function GET(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const [selfServeMonthlyCap, usage] = await Promise.all([
    getWebSelfServeMonthlyCap(prisma),
    countWebSelfServeUsage(prisma, new Date()),
  ]);
  return NextResponse.json({ selfServeMonthlyCap, ...usage });
}

const BodySchema = z.object({
  selfServeMonthlyCap: z.number().int().min(MIN_WEB_SELF_SERVE_MONTHLY_CAP).max(MAX_WEB_SELF_SERVE_MONTHLY_CAP),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  try {
    const operator = await prisma.operator.findUnique({ where: { id: auth.operatorId }, select: { email: true } });
    await updateWebSelfServeMonthlyCap(prisma, body.data.selfServeMonthlyCap, operator?.email ?? null);
  } catch (err) {
    logError('web_sales_settings.save_failed', err, {});
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, selfServeMonthlyCap: body.data.selfServeMonthlyCap });
}
