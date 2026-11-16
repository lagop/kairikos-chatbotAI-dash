import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireVillaPortal } from '@/lib/villas/portal-auth';
import { acceptVillaRequest, cancelVillaRequest, declineVillaRequest } from '@/lib/villas/requests';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/villas/requests/[requestId]
 *   { action: 'accept' }                       vuelve a leer los iCal, comprueba solapes y pide el depósito
 *   { action: 'decline', reason: 'unavailable' | 'other' }
 *   { action: 'cancel' }                       anula una aceptada o confirmada (el reembolso, desde su Stripe)
 *
 * La solicitud se busca dentro de la VillaRental del cliente de la sesión:
 * un id ajeno da 404. Las transiciones y los correos: lib/villas/requests.ts.
 */
const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept') }),
  z.object({ action: z.literal('decline'), reason: z.enum(['unavailable', 'other']).default('unavailable') }),
  z.object({ action: z.literal('cancel') }),
]);

const STATUS: Record<string, number> = {
  not_found: 404,
  invalid_transition: 409,
  expired: 409,
  conflict: 409,
  stripe_not_configured: 409,
};

export async function POST(req: NextRequest, props: { params: Promise<{ requestId: string }> }) {
  const { requestId } = await props.params;
  const ctx = await requireVillaPortal();
  if (!ctx.ok) return ctx.response;
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const base = { rentalId: ctx.rental.id, requestId, actor: ctx.actor };
  const result =
    body.data.action === 'accept'
      ? await acceptVillaRequest(prisma, base)
      : body.data.action === 'decline'
        ? await declineVillaRequest(prisma, { ...base, reason: body.data.reason })
        : await cancelVillaRequest(prisma, base);
  if (!result.ok) return NextResponse.json(result, { status: STATUS[result.error] ?? 400 });
  return NextResponse.json(result);
}
