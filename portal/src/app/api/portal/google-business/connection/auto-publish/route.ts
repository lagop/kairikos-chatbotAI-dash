import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveReviewConnection } from '@/lib/review-locations';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { hasGoogleBusinessConnectAccess } from '@/lib/google-business';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Fase 3 — `connectionId` es opcional: un cliente de un solo local no lo
// manda y se resuelve el suyo, que es lo que mantiene la ruta compatible.
const BodySchema = z.object({ enabled: z.boolean(), connectionId: z.string().uuid().optional() });

/**
 * WP-22c — PATCH /api/portal/google-business/connection/auto-publish
 * Toggles autoPublishReplies for the client's connection. The AC's
 * audit requirement ("queda auditado con quién y cuándo lo cambió") is
 * satisfied by autoPublishRepliesChangedBy/At — always overwritten with
 * the current change, not appended to a history table (a single boolean
 * setting doesn't need more than "who set it last and when").
 */
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const hasAccess = await hasGoogleBusinessConnectAccess(resolved.clientId);
  if (!hasAccess) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  // Fase 3 — publicar respuestas solo se activa para el local que se
  // indique: es un ajuste POR UBICACIÓN (la columna vive en la conexión),
  // y aplicarlo al local equivocado publica en el Google de otro negocio.
  const connection = await resolveReviewConnection(prisma, resolved.clientId, body.data.connectionId);
  if (!connection) {
    return NextResponse.json({ error: body.data.connectionId ? 'not_connected' : 'location_required' }, { status: 404 });
  }

  const updated = await prisma.googleBusinessConnection.update({
    where: { id: connection.id },
    data: {
      autoPublishReplies: body.data.enabled,
      autoPublishRepliesChangedBy: `client:${resolved.clientId}`,
      autoPublishRepliesChangedAt: new Date(),
    },
  });

  return NextResponse.json({
    autoPublishReplies: updated.autoPublishReplies,
    changedAt: updated.autoPublishRepliesChangedAt,
  });
}
