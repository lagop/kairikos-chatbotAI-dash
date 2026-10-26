import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { refreshExpiredLeadsForClient } from '@/lib/places-retention';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * 26/10/2026 — «Actualizar los N caducados» de un cliente, desde su ficha en
 * el admin. Recorre sus prospectos purgados (lib/places-retention.ts) y se
 * para al llegar al tope del día, que es el mismo que el de un clic suelto:
 * como mucho CLIENT_DAILY_REFRESH_CAP llamadas a Google por cliente y día.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const { id: clientId } = await props.params;
  const client = await prisma.chatbotClient.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const result = await refreshExpiredLeadsForClient(prisma, { clientId, actorId: auth.operatorId });
  const parts = [`${result.refreshed} actualizados`];
  if (result.unavailable > 0) parts.push(`${result.unavailable} que Google ya no encuentra o figuran cerrados`);
  if (result.failed > 0) parts.push(`${result.failed} sin respuesta de Google`);
  const message = `${parts.join(', ')}.${result.stoppedAtCap ? ' Se ha llegado al tope de hoy: el resto, mañana.' : ''}`;
  return NextResponse.json({ ok: true, ...result, message });
}
