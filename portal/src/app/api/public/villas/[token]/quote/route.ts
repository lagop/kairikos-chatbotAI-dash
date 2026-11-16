import type { NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { findRentalByPublicToken, loadBusyRanges, rentalToday, toPricing, toSeasons } from '@/lib/villas/rental';
import { isRangeFree } from '@/lib/villas/availability';
import { quoteStay } from '@/lib/villas/pricing';
import { allowRead, corsJson, corsPreflight, intParam } from '@/lib/villas/public-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/villas/[token]/quote?villa=<slug>&entrada=2026-12-14&salida=2026-12-21&adultos=2&ninos=0
 *
 * El precio total de la estancia con IVA incluido y su desglose, ANTES de
 * enviar nada: es la regla de la web («precio total con IVA antes de pagar»).
 * Los nombres de los parámetros son los del motor del hotel (docs/reserva.md
 * del repositorio de la demo), para que la web pase su URL tal cual.
 *
 * GET y no POST: sin cuerpo JSON no hay petición previa de CORS, y es una
 * lectura.
 */
export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  if (!allowRead(token)) return corsJson({ error: 'too_many_requests' }, 429);
  if (!isDatabaseConfigured) return corsJson({ error: 'service_unavailable' }, 503);

  const rental = await findRentalByPublicToken(prisma, token);
  if (!rental) return corsJson({ error: 'not_found' }, 404);
  const q = req.nextUrl.searchParams;
  const villa = rental.villas.find((v) => v.slug === q.get('villa'));
  if (!villa) return corsJson({ error: 'villa_not_found' }, 404);

  const today = rentalToday(rental);
  const checkIn = q.get('entrada') ?? '';
  const checkOut = q.get('salida') ?? '';
  const result = quoteStay(
    toPricing(villa),
    toSeasons(villa.seasons),
    { checkIn, checkOut, adults: intParam(q.get('adultos'), 2, 0, 50), children: intParam(q.get('ninos'), 0, 0, 50) },
    { depositPercent: rental.depositPercent, today },
  );
  if (!result.ok) return corsJson({ ok: false, error: result.error, minNights: result.minNights ?? null }, 200);

  const busy = await loadBusyRanges(prisma, villa.id, { today });
  const available = isRangeFree(busy, checkIn, checkOut);
  return corsJson({ ok: true, available, quote: result.quote }, 200, { 'Cache-Control': 'no-store' });
}
