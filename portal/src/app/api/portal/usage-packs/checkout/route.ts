import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { createUsagePackCheckout, type UsagePackCheckoutError } from '@/lib/usage-packs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/usage-packs/checkout
 *   body: { packCode: 'pack_chatbot_messages' | 'pack_prospecting_leads',
 *           clientProductId?: UUID }
 *
 * Plan de precios del 01/10/2026 — abre el pago de un pack de uso. El saldo lo
 * suma el webhook al confirmarse el cobro, no esta ruta.
 *
 * clientProductId es el chatbot (o la campaña) que recibe el saldo. No
 * autoriza nada por sí solo: createUsagePackCheckout lo resuelve contra el
 * cliente de la sesión, así que un id ajeno da target_not_found.
 */
const BodySchema = z.object({
  packCode: z.string().min(1).max(64),
  clientProductId: z.string().uuid().nullish(),
});

const ERROR_STATUS: Record<UsagePackCheckoutError, number> = {
  unknown_pack: 400,
  target_not_found: 404,
  pack_not_on_sale: 409,
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
  if (!resolved || resolved.source !== 'database') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const result = await createUsagePackCheckout({
    clientId: resolved.clientId,
    packCode: body.data.packCode,
    targetClientProductId: body.data.clientProductId ?? null,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] });
  return NextResponse.json({ url: result.url });
}
