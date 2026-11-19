import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { activateCartera } from '@/lib/cartera/site';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/portal/cartera   body: { clientId }
 *
 * Cartera de Signature inmobiliaria — el operador activa el módulo para un
 * cliente. No hay autoservicio ni checkout: va dentro del presupuesto de
 * Signature. Crea (o reactiva) la contratación 'cartera' y su CarteraSite
 * vacío, con el token del feed. Idempotente: llamarla dos veces devuelve el
 * mismo sitio.
 *
 * `feedToken` solo viene la primera vez (201). Después sale null: si se
 * perdió, se regenera con PATCH /api/admin/portal/cartera/[siteId]. Sin TOTP,
 * como villas: activar no cobra nada ni publica nada.
 */
const BodySchema = z.object({ clientId: z.string().trim().min(1).max(64) });

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const result = await prisma.$transaction((tx) => activateCartera(tx, { clientId: body.data.clientId, operatorId: auth.operatorId }));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === 'client_not_found' ? 404 : 409 });
  }
  return NextResponse.json(result, { status: result.created ? 201 : 200, headers: { 'Cache-Control': 'no-store' } });
}
