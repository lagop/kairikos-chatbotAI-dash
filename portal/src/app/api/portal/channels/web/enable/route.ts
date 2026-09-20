import { randomBytes } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { resolveContractedInstance } from '@/lib/client-product-access';
import { isChannelAllowedForClient } from '@/lib/channel-access';
import { deliverChannelEvent } from '@/lib/channel-webhook';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Canales Fase 4 — POST /api/portal/channels/web/enable
//
// Same triple gate as Telegram/Meta connect routes: real session
// (getSession, not just resolveClientFromSession()'s dev-mock
// fallback), then isProductContracted('chatbot'), then
// isChannelAllowedForClient('web'). Unlike Telegram/Meta, there is no
// external credential to validate — activating the Web channel just
// means "generate a publicToken and flip status to active", so this
// route is idempotent: re-enabling an already-active embed keeps the
// SAME publicToken (a client who copies the snippet, then clicks
// "activar" again, should not get a token that invalidates the one
// already pasted into their site).
// =============================================================================

function generatePublicToken(): string {
  return `wgt_${randomBytes(24).toString('base64url')}`;
}

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

  // Fase 4 multi-instancia — a QUÉ chatbot se le activa el widget. Cada
  // negocio pega el suyo en su propia web; el id llega por query desde la
  // pantalla de canales de ese chatbot.
  const instance = await resolveContractedInstance(prisma, {
    clientId: resolved.clientId,
    productCode: CHATBOT_PRODUCT_CODE,
    clientProductId: req.nextUrl.searchParams.get('clientProductId'),
  });
  if (!instance) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // La tarifa que cuenta es la de ESTE chatbot.
  const channelAllowed = await isChannelAllowedForClient(prisma, resolved.clientId, 'web', instance.clientProductId);
  if (!channelAllowed) {
    return NextResponse.json({ error: 'channel_not_in_plan' }, { status: 403 });
  }

  // El widget de ESTE chatbot. Antes era el del cliente: con dos chatbots,
  // activar el del segundo habría reactivado el del primero.
  const existing = await prisma.chatWebEmbed.findFirst({
    where: { clientId: resolved.clientId, clientProductId: instance.clientProductId },
  });

  let embed;
  if (existing) {
    embed = await prisma.chatWebEmbed.update({ where: { id: existing.id }, data: { status: 'active' } });
  } else {
    const client = await prisma.chatbotClient.findUnique({ where: { id: resolved.clientId }, select: { tenantId: true } });
    embed = await prisma.chatWebEmbed.create({
      data: {
        clientId: resolved.clientId,
        clientProductId: instance.clientProductId,
        tenantId: client?.tenantId ?? null,
        publicToken: generatePublicToken(),
        status: 'active',
      },
    });
  }

  await deliverChannelEvent({
    connectionType: 'web',
    connectionId: embed.id,
    clientId: resolved.clientId,
    payload: { event: 'connected', publicToken: embed.publicToken },
  });

  return NextResponse.json({ ok: true, publicToken: embed.publicToken, status: embed.status, primaryColor: embed.primaryColor, position: embed.position });
}
