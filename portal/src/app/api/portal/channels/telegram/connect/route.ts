import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { isChannelAllowedForClient } from '@/lib/channel-access';
import { encryptChannelCredential } from '@/lib/channel-crypto';
import { deliverChannelEvent } from '@/lib/channel-webhook';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// WP: conexión de canales — POST /api/portal/channels/telegram/connect
//
// Client-facing: the client creates their own bot via @BotFather and
// pastes the token here. Validated against the Bot API's `getMe` before
// anything is saved — a garbage token fails fast with a clear error
// instead of silently persisting something that will never work. Gated
// on getSession() (real session, not just resolveClientFromSession()'s
// dev-mock fallback — see the sidebar/product-page auth fix this same
// session), THEN on isProductContracted('chatbot'), THEN on the
// client's chatbot tier actually including 'telegram'
// (isChannelAllowedForClient) — three separate reasons a connect
// attempt can be rejected, three separate error codes.
// =============================================================================

const BodySchema = z.object({ botToken: z.string().trim().min(1, 'required') });

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

  const hasChatbot = await isProductContracted(prisma, resolved.clientId, 'chatbot');
  if (!hasChatbot) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const channelAllowed = await isChannelAllowedForClient(prisma, resolved.clientId, 'telegram');
  if (!channelAllowed) {
    return NextResponse.json({ error: 'channel_not_in_plan' }, { status: 403 });
  }

  const botToken = body.data.botToken;
  let botUsername: string;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: { username?: string } } | null;
    if (!res.ok || !data?.ok || !data.result?.username) {
      return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
    }
    botUsername = data.result.username;
  } catch (err) {
    logError('channels.telegram_connect.getme_failed', err, { clientId: resolved.clientId }, 'warn');
    return NextResponse.json({ error: 'telegram_api_error' }, { status: 502 });
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { tenantId: true },
  });

  const encrypted = encryptChannelCredential(botToken);
  const connection = await prisma.telegramConnection.upsert({
    where: { clientId: resolved.clientId },
    update: {
      botTokenCiphertext: encrypted.ciphertext,
      botTokenIv: encrypted.iv,
      botTokenTag: encrypted.tag,
      botUsername,
      status: 'active',
      lastSyncError: null,
    },
    create: {
      clientId: resolved.clientId,
      tenantId: client?.tenantId ?? null,
      botTokenCiphertext: encrypted.ciphertext,
      botTokenIv: encrypted.iv,
      botTokenTag: encrypted.tag,
      botUsername,
      status: 'active',
    },
  });

  // Fire-and-persist: deliverChannelEvent always audits the attempt
  // (ChannelWebhookDelivery) and never throws. n8n is responsible for
  // subscribing Telegram's setWebhook once it has this credential — the
  // portal's job ends here.
  await deliverChannelEvent({
    connectionType: 'telegram',
    connectionId: connection.id,
    clientId: resolved.clientId,
    payload: { event: 'connected', botUsername },
  });

  return NextResponse.json({ ok: true, botUsername, status: 'active' });
}
