import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { isProductContracted } from '@/lib/client-product-access';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ enabled: z.boolean() });

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

  const hasReviews = await isProductContracted(prisma, resolved.clientId, 'reviews');
  if (!hasReviews) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const connection = await prisma.googleBusinessConnection.findFirst({
    where: { clientId: resolved.clientId, status: 'active' },
  });
  if (!connection) return NextResponse.json({ error: 'not_connected' }, { status: 404 });

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
