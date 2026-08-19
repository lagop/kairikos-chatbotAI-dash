import { NextResponse } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { deliverChannelEvent } from '@/lib/channel-webhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales Fase 4 — POST /api/portal/channels/web/disable
//
// Idempotent, same as Telegram/Meta disconnect: a widget already
// disabled just returns alreadyDisabled=true without re-delivering a
// webhook event. Keeps the publicToken (not deleted) so re-enabling
// later doesn't invalidate the snippet already pasted into the
// client's site.
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

  const embed = await prisma.chatWebEmbed.findFirst({ where: { clientId: resolved.clientId } });
  if (!embed) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (embed.status === 'disabled') {
    return NextResponse.json({ ok: true, status: 'disabled', alreadyDisabled: true });
  }

  await prisma.chatWebEmbed.update({ where: { id: embed.id }, data: { status: 'disabled' } });

  await deliverChannelEvent({
    connectionType: 'web',
    connectionId: embed.id,
    clientId: resolved.clientId,
    payload: { event: 'disconnected' },
  });

  return NextResponse.json({ ok: true, status: 'disabled' });
}
