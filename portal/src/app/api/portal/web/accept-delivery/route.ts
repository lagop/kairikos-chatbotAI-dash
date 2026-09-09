import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Fase 3 — POST /api/portal/web/accept-delivery
 *
 * El cliente da su web por buena.
 *
 * Es la única acción del seguimiento de entrega que ejecuta ÉL, y por eso
 * vive en /api/portal y no en /api/admin: el resto de etapas las mueve el
 * operador. Cierra el ciclo que hoy acababa en el cobro — y deja la fecha
 * en la que el trabajo se dio por terminado, que es lo que hace falta
 * cuando alguien reclama meses después.
 *
 * No cambia el `status` del presupuesto: 'paid' sigue describiendo el
 * dinero, y mezclar en esa columna el estado de la ENTREGA obligaría a
 * revisar la máquina de estados de facturación entera.
 */
export async function POST(_req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const quote = await prisma.webQuote.findFirst({
      where: { clientId: resolved.clientId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, deliveredAt: true, deliveryAcceptedAt: true },
    });
    if (!quote) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    // Aceptar algo que no se ha entregado no significa nada, y dejaría una
    // fecha de conformidad anterior a la entrega.
    if (!quote.deliveredAt) {
      return NextResponse.json({ error: 'not_delivered' }, { status: 409 });
    }
    // Ya aceptada: se responde ok, no un error. Un doble clic no es un
    // fallo del cliente.
    if (quote.deliveryAcceptedAt) {
      return NextResponse.json({ ok: true, acceptedAt: quote.deliveryAcceptedAt.toISOString() });
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.webQuote.update({ where: { id: quote.id }, data: { deliveryAcceptedAt: now } });
      await tx.webQuoteAudit.create({
        data: {
          webQuoteId: quote.id,
          action: 'delivery_accepted',
          after: { deliveryAcceptedAt: now.toISOString() },
          actorType: 'client',
          actorEmail: `client:${resolved.clientId}`,
        },
      });
    });

    return NextResponse.json({ ok: true, acceptedAt: now.toISOString() });
  } catch (err) {
    logError('portal.web_accept_delivery.failed', err, { clientId: resolved.clientId }, 'error');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
