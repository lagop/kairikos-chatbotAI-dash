import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Fase 3 — PATCH /api/portal/recall/review-location
//
// A qué local pide reseñas la recuperación de llamadas.
//
// Hasta ahora esto no se elegía: el callback de OAuth ataba
// RecallSubscription.googleConnectionId a la única conexión que podía
// existir. Con varios locales esa atadura pasa a ser «el primero que se
// conectó», que para una cadena es una respuesta al azar — y las
// invitaciones a reseñar de las llamadas de la tienda de Vigo acabarían
// puntuando la de Madrid.
// =============================================================================

const BodySchema = z.object({ connectionId: z.string().uuid() });

export async function PATCH(req: NextRequest) {
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

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  try {
    // El clientId va dentro: un local de otra empresa no existe.
    const connection = await prisma.googleBusinessConnection.findFirst({
      where: { id: body.data.connectionId, clientId: resolved.clientId, status: 'active' },
      select: { id: true, locationName: true },
    });
    if (!connection) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // updateMany y no update: el filtro por clientId es lo que impide
    // reapuntar la suscripción de otro.
    const updated = await prisma.recallSubscription.updateMany({
      where: { clientId: resolved.clientId, status: 'active' },
      data: { googleConnectionId: connection.id },
    });
    if (updated.count === 0) {
      return NextResponse.json({ error: 'no_subscription' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, locationName: connection.locationName });
  } catch (err) {
    logError('portal.recall_review_location.failed', err, { clientId: resolved.clientId }, 'error');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
