import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { refreshHttpStatus, refreshLeadPlacesData, refreshResultMessage } from '@/lib/places-retention';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 26/10/2026 — «Actualizar desde Google» de un prospecto, desde la ficha del
 * cliente en el admin. Mismo refresco que el del portal (lib/places-retention.ts),
 * sin comprobación de cliente porque el operador ve todos, y contando contra
 * el tope del cliente al que pertenece el lead: el gasto es el mismo pulse
 * quien pulse.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const { id } = await props.params;
  const result = await refreshLeadPlacesData(prisma, { leadId: id, actorId: auth.operatorId });
  return NextResponse.json(
    { ok: result.ok, ...(result.ok ? {} : { error: result.reason }), message: refreshResultMessage(result) },
    { status: refreshHttpStatus(result) },
  );
}
