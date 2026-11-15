import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { findRentalByPublicToken } from '@/lib/villas/rental';
import { createVillaRequest } from '@/lib/villas/requests';
import { isIsoDate } from '@/lib/villas/dates';
import { allowWrite, corsJson, corsPreflight } from '@/lib/villas/public-http';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/public/villas/[token]/requests — el huésped envía su solicitud.
 *
 * NO es una reserva ni cobra nada: crea una solicitud 'pending' que el dueño
 * acepta o rechaza (lib/villas/requests.ts). El precio lo calcula el servidor
 * con las temporadas de ese momento y queda congelado en la solicitud; lo que
 * mande el navegador como total no se usa.
 *
 * `consent` tiene que ser true (la casilla de privacidad del widget). `website`
 * es un campo trampa invisible: si llega relleno, se responde como si todo
 * fuera bien y no se guarda nada.
 */
const BodySchema = z.object({
  villa: z.string().trim().min(1).max(60),
  checkIn: z.string().refine(isIsoDate),
  checkOut: z.string().refine(isIsoDate),
  adults: z.number().int().min(1).max(50),
  children: z.number().int().min(0).max(50).default(0),
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(40).optional().nullable(),
  message: z.string().trim().max(1500).optional().nullable(),
  lang: z.enum(['es', 'en']).default('es'),
  consent: z.literal(true),
  source: z.string().trim().max(40).optional().nullable(),
  website: z.string().max(200).optional(),
});

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return corsJson({ ok: false, error: 'invalid_body', fields: Object.keys(body.error.flatten().fieldErrors) }, 400);
  if (body.data.website) return corsJson({ ok: true, reference: null }, 201);
  if (!allowWrite(token)) return corsJson({ ok: false, error: 'too_many_requests' }, 429);
  if (!isDatabaseConfigured) return corsJson({ ok: false, error: 'service_unavailable' }, 503);

  const rental = await findRentalByPublicToken(prisma, token);
  if (!rental) return corsJson({ ok: false, error: 'not_found' }, 404);

  try {
    const result = await createVillaRequest(prisma, rental, {
      villaSlug: body.data.villa,
      checkIn: body.data.checkIn,
      checkOut: body.data.checkOut,
      adults: body.data.adults,
      children: body.data.children,
      guestName: body.data.name,
      guestEmail: body.data.email,
      guestPhone: body.data.phone ?? null,
      message: body.data.message ?? null,
      lang: body.data.lang,
      source: body.data.source ?? null,
    });
    if (!result.ok) {
      const status = result.error === 'villa_not_found' ? 404 : result.error === 'unavailable' ? 409 : 422;
      return corsJson({ ok: false, error: result.error, minNights: result.minNights ?? null }, status);
    }
    return corsJson(
      {
        ok: true,
        reference: result.reference,
        statusUrl: result.statusUrl,
        confirmHours: rental.confirmHours,
        totalCents: result.quote.totalCents,
        depositCents: result.quote.depositCents,
      },
      201,
    );
  } catch (err) {
    logError('villas.request.create_failed', err, { rentalId: rental.id }, 'error');
    return corsJson({ ok: false, error: 'server_error' }, 500);
  }
}
