import type { NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { findRentalByPublicToken, loadBusyRanges, rentalToday, toPricing, toSeasons } from '@/lib/villas/rental';
import { buildCalendar } from '@/lib/villas/availability';
import { addMonths, isIsoDate, startOfMonth } from '@/lib/villas/dates';
import { allowRead, corsJson, corsPreflight, intParam } from '@/lib/villas/public-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/villas/[token]/calendar?villa=<slug>&desde=2026-12&meses=2
 *
 * Día a día: si la noche está libre, su precio (IVA incluido) y la estancia
 * mínima si se llega ese día. Es lo que pinta la rejilla del widget. No dice
 * POR QUÉ un día está ocupado (Airbnb, Booking, otra solicitud): al huésped no
 * le hace falta y al dueño no le conviene.
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
  const villa = rental.villas.find((v) => v.slug === req.nextUrl.searchParams.get('villa'));
  if (!villa) return corsJson({ error: 'villa_not_found' }, 404);

  const today = rentalToday(rental);
  const desde = req.nextUrl.searchParams.get('desde');
  const requested = desde && isIsoDate(`${desde}-01`) ? `${desde}-01` : startOfMonth(today);
  const from = requested < startOfMonth(today) ? startOfMonth(today) : requested;
  const months = intParam(req.nextUrl.searchParams.get('meses'), 2, 1, 3);
  const to = addMonths(from, months);

  const busy = await loadBusyRanges(prisma, villa.id, { today });
  const days = buildCalendar(toPricing(villa), toSeasons(villa.seasons), busy, from, to, today);
  return corsJson({ villa: villa.slug, from, to, today, days }, 200, { 'Cache-Control': 'no-store' });
}
