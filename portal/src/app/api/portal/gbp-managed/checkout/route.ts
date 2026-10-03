import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { createGbpManagedCheckout } from '@/lib/gbp-managed';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/gbp-managed/checkout
 *   body: { connectionId?: UUID, billing?: 'monthly' | 'annual', from?: 'resenas' | 'seo' }
 *
 * Plan de precios del 01/10/2026 — contratar la Ficha de Google gestionada.
 * connectionId es la ficha elegida; no autoriza nada por sí solo:
 * createGbpManagedCheckout la busca entre las del cliente de la sesión.
 */
const BodySchema = z.object({
  connectionId: z.string().uuid().nullish(),
  billing: z.enum(['monthly', 'annual']).optional(),
  from: z.enum(['resenas', 'seo']).optional(),
});

const ERROR_STATUS: Record<string, number> = {
  not_on_sale: 409,
  connection_not_found: 404,
  already_managed: 409,
  annual_price_missing: 400,
  stripe_not_configured: 503,
  client_has_no_tenant: 503,
  stripe_customer_create_failed: 503,
  stripe_error: 502,
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const result = await createGbpManagedCheckout(prisma, {
    clientId: resolved.clientId,
    connectionId: body.data.connectionId ?? null,
    billing: body.data.billing ?? 'monthly',
    actorId: `client:${resolved.clientId}`,
    returnPath: body.data.from === 'seo' ? '/portal/seo' : '/portal/resenas',
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] ?? 400 });
  return NextResponse.json({ url: result.url });
}
