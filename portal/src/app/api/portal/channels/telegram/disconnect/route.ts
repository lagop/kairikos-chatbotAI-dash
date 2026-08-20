import { NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { deliverChannelEvent } from '@/lib/channel-webhook';
import { decryptChannelCredential } from '@/lib/channel-crypto';
import { deleteWebhook } from '@/lib/telegram-api';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// WP: conexión de canales — POST /api/portal/channels/telegram/disconnect
//
// The token itself can only be invalidated by regenerating it via
// @BotFather, not through the Bot API — but deleteWebhook (best-effort,
// same "never leaves the client stuck" posture as Meta's disconnect) IS
// a real, useful call: it stops Telegram from delivering messages to
// n8n's per-connection URL. Disconnecting is local either way: mark the
// row `revoked` and forget the token regardless of whether deleteWebhook
// succeeded. A later reconnect re-upserts the same row back to `active`
// with a fresh token and re-registers the webhook.
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

  try {
    const token = decryptChannelCredential({
      ciphertext: connection.botTokenCiphertext,
      iv: connection.botTokenIv,
      tag: connection.botTokenTag,
    });
    const result = await deleteWebhook(token);
    if (!result.ok) {
      logError('channels.telegram_disconnect.delete_webhook_failed', new Error(result.error), { clientId: resolved.clientId, connectionId: connection.id }, 'warn');
    }
  } catch (err) {
    // Best-effort — never blocks the disconnect. A stale webhook
    // subscription left on Telegram's side is harmless: the connection
    // row is about to be marked revoked, so the multi-tenant n8n
    // workflow's context lookup for this connectionId will 404/403 any
    // update Telegram still delivers.
    logError('channels.telegram_disconnect.delete_webhook_failed', err, { clientId: resolved.clientId, connectionId: connection.id }, 'warn');
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
