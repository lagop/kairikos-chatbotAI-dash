import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 25/10/2026 — POST /api/admin/portal/borradores/contactado
 *
 * Marca como contactado un contacto entrante (borrador de web o calculadora).
 * Hasta hoy contactedAt existía en las dos tablas y nada lo escribía: la
 * pantalla decía «Por llamar» para siempre. Ahora importa además porque corta
 * el seguimiento por correo (lib/inbound-follow-up.ts): en cuanto el operador
 * ha hablado con alguien, la relación es una conversación y no una secuencia.
 *
 * Sin vuelta atrás desde aquí, a propósito: desmarcarlo reactivaría correos a
 * alguien con quien ya se ha hablado. Sin TOTP: no toca dinero.
 */
const BodySchema = z.object({
  source: z.enum(['web_draft', 'calculator']),
  id: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  const where = { id: body.data.id, contactedAt: null };
  const data = { contactedAt: new Date() };
  const res =
    body.data.source === 'web_draft'
      ? await prisma.publicDraftRequest.updateMany({ where, data })
      : await prisma.calculatorLead.updateMany({ where, data });

  return NextResponse.json({ ok: true, updated: res.count });
}
