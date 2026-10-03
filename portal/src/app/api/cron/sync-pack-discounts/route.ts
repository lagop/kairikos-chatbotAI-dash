import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { syncPackDiscounts } from '@/lib/pack-discounts';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { isStripeConfigured } from '@/lib/stripe';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Plan de precios del 01/10/2026 — GET /api/cron/sync-pack-discounts
 *
 * Deja en Stripe el descuento del pack (Oficio, Presencia) que corresponde a
 * cada cliente según lo que tiene contratado ahora, o ninguno
 * (lib/pack-discounts.ts). Idempotente: solo llama a Stripe cuando cambia.
 * Añadida a scripts/scheduler.sh en el mismo commit.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured || !(await isStripeConfigured())) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const result = await syncPackDiscounts(prisma);
  return NextResponse.json(result);
}
