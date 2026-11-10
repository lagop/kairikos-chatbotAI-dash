import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { assignSiteToNewContract } from '@/lib/client-site';
import { createCustomCareOffer, withdrawCustomCareOffer } from '@/lib/custom-care';
import { MAX_TRIAL_MONTHS } from '@/lib/custom-care-rules';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST   /api/admin/portal/web/[clientProductId]/custom-care
 *   body: { priceCents, trialMonths }
 * DELETE /api/admin/portal/web/[clientProductId]/custom-care
 *   body: { offerClientProductId }
 *
 * 11/11/2026 — el mantenimiento a medida de una web que ya existe («solo
 * mantenimiento»; ver lib/custom-care.ts). Ofrecer no cobra ni activa nada:
 * la oferta aparece en la página de la web del cliente y es él quien la
 * activa guardando su tarjeta. Por eso no pide TOTP, igual que guardar un
 * presupuesto: el paso que compromete lo da el cliente, con el precio a la
 * vista. Una oferta nueva sustituye a la pendiente de esa web.
 *
 * El id de la URL es el de la web ('web' activa); el cliente sale de ella,
 * nunca del cuerpo.
 */
const OfferSchema = z.object({
  priceCents: z.number().int().positive().max(1_000_000),
  trialMonths: z.number().int().min(0).max(MAX_TRIAL_MONTHS),
});
const WithdrawSchema = z.object({ offerClientProductId: z.string().uuid() });

const ERROR_STATUS: Record<string, number> = {
  care_product_missing: 409,
  already_contracted: 409,
  invalid_price: 400,
  invalid_trial: 400,
};

async function loadActiveWeb(clientProductId: string) {
  if (!z.string().uuid().safeParse(clientProductId).success) return null;
  return prisma.clientProduct.findFirst({
    where: { id: clientProductId, status: 'active', product: { code: 'web' } },
    select: { id: true, clientId: true, tenantId: true, clientSiteId: true },
  });
}

export async function POST(req: NextRequest, props: { params: Promise<{ clientProductId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = OfferSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });

  const web = await loadActiveWeb(params.clientProductId);
  if (!web) return NextResponse.json({ error: 'web_not_found' }, { status: 404 });

  const result = await prisma.$transaction(async (tx) => {
    // Una web antigua puede no tener sitio todavía: se le asigna, como haría
    // su activación (mismo criterio que createWebCareCheckout).
    const clientSiteId =
      web.clientSiteId ??
      (
        await assignSiteToNewContract(tx, {
          clientId: web.clientId,
          tenantId: web.tenantId,
          clientProductId: web.id,
          productCode: 'web',
        })
      ).clientSiteId;
    return createCustomCareOffer(tx, {
      clientId: web.clientId,
      tenantId: web.tenantId,
      clientSiteId,
      priceCents: body.data.priceCents,
      trialMonths: body.data.trialMonths,
      actorId: auth.operatorId,
    });
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] ?? 400 });
  return NextResponse.json({ ok: true, offerClientProductId: result.clientProductId }, { status: 201 });
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ clientProductId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = WithdrawSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const web = await loadActiveWeb(params.clientProductId);
  if (!web) return NextResponse.json({ error: 'web_not_found' }, { status: 404 });

  // La oferta tiene que ser de ESTE cliente: withdrawCustomCareOffer filtra
  // por clientId, así que un id de otro cliente no encuentra nada.
  const withdrawn = await prisma.$transaction((tx) =>
    withdrawCustomCareOffer(tx, { clientId: web.clientId, clientProductId: body.data.offerClientProductId, actorId: auth.operatorId }),
  );
  if (!withdrawn) return NextResponse.json({ error: 'offer_not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
