import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { deliverChannelEvent } from '@/lib/channel-webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// WP: conexión de canales — POST /api/portal/channels/telegram/disconnect
//
// Unlike Google's disconnect, there is no platform-side "revoke" call to
// make here — a Telegram bot token is only invalidated by regenerating
// it via @BotFather, not through the Bot API. Disconnecting is purely
// local: mark the row `revoked` and forget the token. A later reconnect
// re-upserts the same row back to `active` with a fresh token.
// =============================================================================

export async function POST() {
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

  const connection = await prisma.telegramConnection.findUnique({ where: { clientId: resolved.clientId } });
  if (!connection) {
    return NextResponse.json({ error: 'not_connected' }, { status: 404 });
  }
  if (connection.status === 'revoked') {
    return NextResponse.json({ ok: true, status: 'revoked', alreadyRevoked: true });
  }

  await prisma.telegramConnection.update({
    where: { id: connection.id },
    data: { status: 'revoked' },
  });

  await deliverChannelEvent({
    connectionType: 'telegram',
    connectionId: connection.id,
    clientId: resolved.clientId,
    payload: { event: 'disconnected' },
  });

  return NextResponse.json({ ok: true, status: 'revoked' });
}
