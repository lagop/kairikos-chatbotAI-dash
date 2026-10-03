import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { createWebCareCheckout } from '@/lib/web-care';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/web/[clientProductId]/care/checkout
 *   body: { billing?: 'monthly' | 'annual' }
 *
 * Plan de precios del 01/10/2026 — contratar el Cuidado de ESTA web. El id de
 * la URL no autoriza nada por sí solo: createWebCareCheckout lo resuelve contra
 * el cliente de la sesión, y exige que la web esté activa.
 */
const BodySchema = z.object({ billing: z.enum(['monthly', 'annual']).optional() });

const ERROR_STATUS: Record<string, number> = {
  web_not_found: 404,
  care_not_on_sale: 409,
  already_contracted: 409,
  annual_price_missing: 400,
  stripe_not_configured: 503,
  client_has_no_tenant: 503,
  stripe_customer_create_failed: 503,
  stripe_error: 502,
};

export async function POST(req: NextRequest, props: { params: Promise<{ clientProductId: string }> }) {
  const params = await props.params;
  const session = await getSession();
  if (!session.hasClientAccess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const result = await createWebCareCheckout(prisma, {
    clientId: resolved.clientId,
    webClientProductId: params.clientProductId,
    billing: body.data.billing ?? 'monthly',
    actorId: `client:${resolved.clientId}`,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] ?? 400 });
  }
  return NextResponse.json({ url: result.url });
}
