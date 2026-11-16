import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { activateVillaRental } from '@/lib/villas/rental';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/villas   body: { clientId }
 *
 * Reserva propia para villas — el operador activa el módulo para un cliente.
 * No hay autoservicio: se vende dentro de un presupuesto de Signature («desde
 * 1.800 €, según número de villas»), así que no hay checkout. Crea (o
 * reactiva) la contratación 'villas' y su VillaRental vacía, con el token del
 * widget. Idempotente: llamarla dos veces devuelve la misma.
 *
 * Sin TOTP, como ofrecer un mantenimiento a medida: activar no cobra nada, y
 * el dueño todavía tiene que dar de alta sus villas y su clave de Stripe.
 */
const BodySchema = z.object({ clientId: z.string().trim().min(1).max(64) });

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const result = await prisma.$transaction((tx) => activateVillaRental(tx, { clientId: body.data.clientId, operatorId: auth.operatorId }));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === 'client_not_found' ? 404 : 409 });
  }
  const rental = await prisma.villaRental.findUnique({ where: { id: result.rentalId }, select: { publicToken: true } });
  return NextResponse.json({ ...result, publicToken: rental?.publicToken ?? null }, { status: result.created ? 201 : 200 });
}
