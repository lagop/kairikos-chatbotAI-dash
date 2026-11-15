import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireVillaPortal } from '@/lib/villas/portal-auth';
import { auditVilla } from '@/lib/villas/rental';
import { generatePublicToken, slugify } from '@/lib/villas/request-rules';
import { VillaFieldsSchema } from '@/lib/villas/villa-input';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/portal/villas/villas — el dueño da de alta una villa.
 *
 * El slug (lo que va en ?unidad= de la web) sale del nombre si no se da, y es
 * único dentro de la contratación. Nace con su token de iCal de salida.
 *
 * El número de villas no tiene tope aquí: se vende «según número de villas»
 * y lo controla el presupuesto, no el código.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireVillaPortal();
  if (!ctx.ok) return ctx.response;
  const body = VillaFieldsSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body', fields: Object.keys(body.error.flatten().fieldErrors) }, { status: 400 });

  const { slug: wantedSlug, ...fields } = body.data;
  const slug = wantedSlug ?? slugify(fields.name);
  try {
    const villa = await prisma.villa.create({
      data: { ...fields, slug, rentalId: ctx.rental.id, clientId: ctx.clientId, icalToken: generatePublicToken('ical') },
      select: { id: true, slug: true },
    });
    await auditVilla(prisma, {
      rentalId: ctx.rental.id,
      clientId: ctx.clientId,
      entity: 'villa',
      entityId: villa.id,
      action: 'created',
      actor: ctx.actor,
      metadata: { slug, nightlyCents: fields.nightlyCents, maxGuests: fields.maxGuests },
    });
    return NextResponse.json({ ok: true, ...villa }, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json({ error: 'slug_taken' }, { status: 409 });
    }
    throw err;
  }
}
