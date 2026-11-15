import type { NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { findRentalByPublicToken, rentalToday, toPricing, toSeasons } from '@/lib/villas/rental';
import { fromPriceCents } from '@/lib/villas/availability';
import { MAX_LEAD_DAYS, MAX_NIGHTS } from '@/lib/villas/pricing';
import { hasStripeKey } from '@/lib/villas/stripe-deposit';
import { allowRead, corsJson, corsPreflight } from '@/lib/villas/public-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/villas/[token] — lo que el widget necesita para empezar:
 * las villas (nombre, capacidad, precio «desde», estancia mínima) y las
 * condiciones del dueño. Reserva propia para villas, docs/plan-reserva-villas.md.
 *
 * Pública y con CORS abierto (lib/villas/public-http.ts). No devuelve nada que
 * no vaya a ver el huésped: ni el correo del dueño ni el estado de su Stripe,
 * salvo un booleano `depositReady` para que la web no prometa un pago que
 * todavía no se puede hacer.
 */
export async function OPTIONS() {
  return corsPreflight();
}

export async function GET(_req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  if (!allowRead(token)) return corsJson({ error: 'too_many_requests' }, 429);
  if (!isDatabaseConfigured) return corsJson({ error: 'service_unavailable' }, 503);

  const rental = await findRentalByPublicToken(prisma, token);
  if (!rental) return corsJson({ error: 'not_found' }, 404);
  const today = rentalToday(rental);

  return corsJson(
    {
      businessName: rental.businessName,
      currency: 'EUR',
      today,
      maxNights: MAX_NIGHTS,
      maxLeadDays: MAX_LEAD_DAYS,
      depositPercent: rental.depositPercent,
      confirmHours: rental.confirmHours,
      paymentHours: rental.paymentHours,
      balanceNote: rental.balanceNote,
      cancellationNote: rental.cancellationNote,
      depositReady: hasStripeKey(rental),
      villas: rental.villas.map((v) => ({
        slug: v.slug,
        name: v.name,
        maxGuests: v.maxGuests,
        minNights: v.minNights,
        fromNightlyCents: fromPriceCents(toPricing(v), toSeasons(v.seasons), today),
        cleaningFeeCents: v.cleaningFeeCents,
      })),
    },
    200,
    { 'Cache-Control': 'public, max-age=60' },
  );
}
