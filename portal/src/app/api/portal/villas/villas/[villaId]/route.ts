import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { findOwnedVilla, requireVillaPortal } from '@/lib/villas/portal-auth';
import { auditVilla } from '@/lib/villas/rental';
import { toDbDate } from '@/lib/villas/dates';
import { SeasonsSchema, VillaFieldsSchema } from '@/lib/villas/villa-input';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * PATCH /api/portal/villas/villas/[villaId]
 *   body: { ...campos de la villa (parciales), isActive?, instantBooking?, seasons? }
 *
 * `seasons`, si viene, SUSTITUYE todas las temporadas de la villa: el panel
 * edita la tabla entera y la guarda de una vez, en una transacción. Las
 * solicitudes ya enviadas no cambian (llevan su presupuesto congelado).
 *
 * No hay DELETE: una villa con solicitudes se desactiva (isActive: false),
 * para no perder su historial. Desactivada, sale del widget y su iCal de
 * salida da 404.
 */
const BodySchema = VillaFieldsSchema.partial()
  .extend({ isActive: z.boolean().optional(), instantBooking: z.boolean().optional(), seasons: SeasonsSchema.optional() })
  .strict();

export async function PATCH(req: NextRequest, props: { params: Promise<{ villaId: string }> }) {
  const { villaId } = await props.params;
  const ctx = await requireVillaPortal();
  if (!ctx.ok) return ctx.response;
  const villa = await findOwnedVilla(ctx.rental.id, villaId);
  if (!villa) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body', fields: Object.keys(body.error.flatten().fieldErrors) }, { status: 400 });
  const { seasons, ...fields } = body.data;
  const data = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

  try {
    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) await tx.villa.update({ where: { id: villa.id }, data });
      if (seasons) {
        await tx.villaSeason.deleteMany({ where: { villaId: villa.id } });
        if (seasons.length > 0) {
          await tx.villaSeason.createMany({
            data: seasons.map((s) => ({
              villaId: villa.id,
              name: s.name,
              startDate: toDbDate(s.startDate),
              endDate: toDbDate(s.endDate),
              nightlyCents: s.nightlyCents,
              minNights: s.minNights,
            })),
          });
        }
      }
      await auditVilla(tx, {
        rentalId: ctx.rental.id,
        clientId: ctx.clientId,
        entity: 'villa',
        entityId: villa.id,
        action: 'updated',
        actor: ctx.actor,
        metadata: { fields: Object.keys(data), seasons: seasons ? seasons.length : null },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json({ error: 'slug_taken' }, { status: 409 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
}
