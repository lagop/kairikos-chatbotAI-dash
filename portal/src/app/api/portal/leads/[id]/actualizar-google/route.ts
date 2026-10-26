import { NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { refreshHttpStatus, refreshLeadPlacesData, refreshResultMessage } from '@/lib/places-retention';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 26/10/2026 — «Actualizar desde Google» en /portal/leads.
 *
 * Un prospecto que nadie tocó en 30 días pierde los datos que vinieron de
 * Google (lib/places-retention.ts); esto los vuelve a pedir por su place ID
 * y reabre los 30 días. Sin cuerpo: el cliente sale de la sesión y el lead
 * tiene que ser suyo — un id de otro cliente es 404, igual que uno que no
 * existe. Cuenta contra el tope diario por cliente y el global.
 */
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const result = await refreshLeadPlacesData(prisma, {
    leadId: params.id,
    clientId: resolved.clientId,
    actorId: `client:${resolved.clientId}`,
  });
  return NextResponse.json(
    { ok: result.ok, ...(result.ok ? {} : { error: result.reason }), message: refreshResultMessage(result) },
    { status: refreshHttpStatus(result) },
  );
}
