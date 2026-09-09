import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { setMilestone, hasDeliveryTracking, MILESTONE_KEYS, MILESTONE_STATUSES } from '@/lib/web-delivery';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Fase 3 — PATCH /api/admin/portal/web-quotes/[id]/delivery
 *
 * Lo que el operador mueve del proyecto después de cobrar: las etapas, el
 * enlace de vista previa y la entrega.
 *
 * Sin TOTP: nada de esto toca Stripe ni dinero, a diferencia de las rutas
 * hermanas de facturación. Lo más sensible que hace es enseñarle al
 * cliente un enlace.
 *
 * Una sola ruta con tres acciones porque son transiciones del MISMO
 * proyecto y separarlas obligaría a repetir en tres sitios la resolución
 * del presupuesto y su comprobación de estado.
 */
const BodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('milestone'),
    key: z.enum(MILESTONE_KEYS as [string, ...string[]]),
    status: z.enum(MILESTONE_STATUSES),
    note: z.string().trim().max(500).nullable().optional(),
  }),
  z.object({
    action: z.literal('preview'),
    // Vacío borra el enlace: un enlace de vista previa caducado que sigue
    // en pantalla es peor que ninguno.
    previewUrl: z.string().trim().url().max(2000).or(z.literal('')),
  }),
  z.object({ action: z.literal('deliver') }),
]);

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const webQuote = await prisma.webQuote.findUnique({
    where: { id: params.id },
    select: { id: true, clientId: true, tenantId: true, status: true },
  });
  if (!webQuote) return NextResponse.json({ error: 'web_quote_not_found' }, { status: 404 });

  // Antes de que haya dinero encima de la mesa no hay proyecto que seguir:
  // mover etapas de un presupuesto sin aceptar le enseñaría al cliente un
  // trabajo que no ha encargado.
  if (!hasDeliveryTracking(webQuote.status)) {
    return NextResponse.json({ error: 'not_in_delivery', status: webQuote.status }, { status: 409 });
  }

  // Las rutas hermanas registran el operador por su id, no por email.
  const actorOperatorId = auth.operatorId;
  const now = new Date();

  if (body.data.action === 'milestone') {
    const result = await setMilestone(prisma, {
      webQuoteId: webQuote.id,
      clientId: webQuote.clientId,
      tenantId: webQuote.tenantId,
      key: body.data.key,
      status: body.data.status,
      note: body.data.note,
      actorId: actorOperatorId,
      actorType: 'operator',
      now,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ ok: true });
  }

  if (body.data.action === 'preview') {
    const previewUrl = body.data.previewUrl === '' ? null : body.data.previewUrl;
    await prisma.$transaction(async (tx) => {
      await tx.webQuote.update({ where: { id: webQuote.id }, data: { previewUrl } });
      await tx.webQuoteAudit.create({
        data: {
          webQuoteId: webQuote.id,
          action: 'preview_published',
          // El enlace en sí, no un booleano: si el cliente dice que le
          // llevó a una web equivocada, hay que poder mirar cuál era.
          after: { previewUrl },
          actorType: 'operator',
          actorOperatorId,
        },
      });
    });
    return NextResponse.json({ ok: true, previewUrl });
  }

  // deliver
  await prisma.$transaction(async (tx) => {
    await tx.webQuote.update({ where: { id: webQuote.id }, data: { deliveredAt: now } });
    await tx.webQuoteAudit.create({
      data: {
        webQuoteId: webQuote.id,
        action: 'delivered',
        after: { deliveredAt: now.toISOString() },
        actorType: 'operator',
        actorOperatorId,
      },
    });
  });
  return NextResponse.json({ ok: true, deliveredAt: now.toISOString() });
}
