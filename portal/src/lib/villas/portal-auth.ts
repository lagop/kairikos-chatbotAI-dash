import 'server-only';
import { NextResponse } from 'next/server';
import type { VillaRental } from '@prisma/client';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { findRentalForClient } from './rental';

// =============================================================================
// Reserva propia para villas — quién puede tocar el panel.
//
// El cliente sale SIEMPRE de la sesión (getSession + resolveClientFromSession),
// nunca del cuerpo; y la VillaRental, de ese cliente. Cada ruta del panel
// comprueba además que lo que toca (villa, calendario, solicitud) cuelga de
// ESTA VillaRental, así que un id ajeno en la URL da 404.
// =============================================================================

export type VillaPortalContext = { ok: true; clientId: string; actor: string; rental: VillaRental } | { ok: false; response: NextResponse };

export async function requireVillaPortal(): Promise<VillaPortalContext> {
  const session = await getSession();
  if (!session.hasClientAccess) return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  if (!isDatabaseConfigured) return { ok: false, response: NextResponse.json({ error: 'service_unavailable' }, { status: 503 }) };
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return { ok: false, response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  const rental = await findRentalForClient(prisma, resolved.clientId);
  if (!rental) return { ok: false, response: NextResponse.json({ error: 'not_contracted' }, { status: 403 }) };
  return { ok: true, clientId: resolved.clientId, actor: `client:${resolved.clientId}`, rental };
}

/** La villa, solo si es de esta VillaRental. */
export async function findOwnedVilla(rentalId: string, villaId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(villaId)) return null;
  return prisma.villa.findFirst({ where: { id: villaId, rentalId } });
}
