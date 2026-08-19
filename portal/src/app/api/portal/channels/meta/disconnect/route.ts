import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { decryptMetaToken, revokeMetaAccess } from '@/lib/meta-business';
import { deliverChannelEvent } from '@/lib/channel-webhook';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// WP: conexión de canales — POST /api/portal/channels/meta/disconnect
//
// Same shape as Google's disconnect route: ownership check (404, not
// 403, on a mismatch — never confirms another client's row exists),
// idempotent on an already-revoked row, best-effort remote revoke
// (failure logged, never blocks the local disconnect from succeeding).
// =============================================================================

const BodySchema = z.object({ connectionId: z.string().uuid() });

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const resolved = await resolveClientFromSession();
  if (!resolved) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const connection = await prisma.metaChannelConnection.findUnique({ where: { id: body.data.connectionId } });
  if (!connection || connection.clientId !== resolved.clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (connection.status === 'revoked') {
    return NextResponse.json({ ok: true, status: 'revoked', alreadyRevoked: true });
  }

  let revokedAtMeta = false;
  try {
    const accessToken = decryptMetaToken({
      ciphertext: connection.accessTokenCiphertext,
      iv: connection.accessTokenIv,
      tag: connection.accessTokenTag,
    });
    revokedAtMeta = await revokeMetaAccess(accessToken);
  } catch (err) {
    logError('channels.meta_disconnect.revoke_failed', err, { connectionId: connection.id }, 'warn');
  }

  await prisma.metaChannelConnection.update({
    where: { id: connection.id },
    data: { status: 'revoked' },
  });

  await deliverChannelEvent({
    connectionType: 'meta',
    connectionId: connection.id,
    clientId: resolved.clientId,
    payload: { event: 'disconnected', channel: connection.channel, externalId: connection.externalId },
  });

  return NextResponse.json({ ok: true, status: 'revoked', revokedAtMeta });
}
