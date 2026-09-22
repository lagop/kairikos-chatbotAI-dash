import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { markContractSigned } from '@/lib/recall-onboarding';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ subscriptionId: z.string().uuid() });

const ERROR_STATUS: Record<string, number> = {
  subscription_not_found: 404,
  // Legal request, wrong moment — la suscripción ya no está en 'paid'
  // (ya firmó, o está cancelada). Ver canSignContract().
  invalid_status: 409,
};

/**
 * Fase 6 — POST /api/admin/portal/recall/contract/sign
 *
 * "Contrato firmado" no lo detecta el sistema — es una llamada o un
 * correo fuera del portal (ver la copia del cliente en /portal/llamadas:
 * "en breve te contactamos para firmar"). Esta ruta es el operador
 * confirmando ese hecho, el único paso manual de la secuencia feliz que
 * no es la unión de un recurso (número, WhatsApp, plantillas) — por eso
 * tiene su propia ruta en vez de colgarse de RecallOperatorPanel como un
 * botón genérico, mismo criterio que number/assign.
 *
 * Sin cuerpo de contrato, sin adjunto: el contrato en sí vive fuera del
 * portal (PDF por correo, firma física). Esto solo sella la fecha.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const result = await markContractSigned(prisma, body.data.subscriptionId, {
    operatorId: auth.operatorId,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: ERROR_STATUS[result.error] ?? 400 });
  }

  return NextResponse.json({ ok: true, subscriptionId: body.data.subscriptionId, status: 'contract_signed' });
}
