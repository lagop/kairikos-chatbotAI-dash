import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { deliverChannelEvent } from '@/lib/channel-webhook';
import { resolveClientWebEmbed } from '@/lib/chat-web-embed';

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

  // Fase 4 multi-instancia — el widget de UN chatbot. Ver lib/chat-web-embed.ts.
  const found = await resolveClientWebEmbed(
    prisma,
    resolved.clientId,
    req.nextUrl.searchParams.get('clientProductId'),
  );
  if (!found.ok && found.reason === 'ambiguous') {
    return NextResponse.json({ error: 'chatbot_not_specified' }, { status: 409 });
  }
  const embed = found.ok ? found.embed : null;
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
