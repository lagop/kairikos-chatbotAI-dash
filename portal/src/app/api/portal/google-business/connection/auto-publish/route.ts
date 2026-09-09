import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { resolveToggleTarget } from '@/lib/google-business-toggle';

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
 *
 * Fase 3 — publicar respuestas solo se activa para el local que se
 * indique: es un ajuste POR UBICACIÓN (la columna vive en la conexión),
 * y aplicarlo al local equivocado publica en el Google de otro negocio.
 * Esa resolución, junto con la sesión y el acceso al producto, vive en
 * resolveToggleTarget desde que existe un segundo interruptor
 * (connection/auto-request).
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
      autoPublishReplies: body.data.enabled,
      autoPublishRepliesChangedBy: `client:${target.clientId}`,
      autoPublishRepliesChangedAt: new Date(),
    },
  });

  return NextResponse.json({
    autoPublishReplies: updated.autoPublishReplies,
    changedAt: updated.autoPublishRepliesChangedAt,
  });
}
