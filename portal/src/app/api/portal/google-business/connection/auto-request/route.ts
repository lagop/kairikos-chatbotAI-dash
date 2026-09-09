import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { resolveToggleTarget } from '@/lib/google-business-toggle';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ enabled: z.boolean(), connectionId: z.string().uuid().optional() });

/**
 * Fase 5 — PATCH /api/portal/google-business/connection/auto-request
 *
 * Enciende o apaga la invitación automática a reseñar a los leads que el
 * cliente marca 'convertido' (src/lib/review-requests-from-leads.ts).
 *
 * Ruta hermana de connection/auto-publish y no una acción más dentro de
 * ella, aunque el preámbulo sea el mismo (resolveToggleTarget): son dos
 * permisos con consecuencias muy distintas. auto-publish escribe en
 * nombre del cliente en SU propia ficha; esto escribe a SUS CLIENTES
 * FINALES. Fundirlos en un cuerpo discriminado haría que activar uno
 * pareciera del mismo tamaño que activar el otro.
 *
 * La auditoría es el par changedBy/changedAt, igual que su hermana: quién
 * lo dejó puesto así y cuándo, que es todo lo que un booleano necesita.
 */
export async function PATCH(req: NextRequest) {
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const target = await resolveToggleTarget(body.data.connectionId);
  if (!target.ok) return target.response;

  const updated = await prisma.googleBusinessConnection.update({
    where: { id: target.connectionId },
    data: {
      autoRequestFromLeads: body.data.enabled,
      autoRequestFromLeadsChangedBy: `client:${target.clientId}`,
      autoRequestFromLeadsChangedAt: new Date(),
    },
  });

  return NextResponse.json({
    autoRequestFromLeads: updated.autoRequestFromLeads,
    changedAt: updated.autoRequestFromLeadsChangedAt,
  });
}
