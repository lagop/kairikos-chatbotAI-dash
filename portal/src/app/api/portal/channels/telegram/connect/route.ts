import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { isChannelAllowedForClient } from '@/lib/channel-access';
import { encryptChannelCredential } from '@/lib/channel-crypto';
import { deliverChannelEvent } from '@/lib/channel-webhook';
import { setWebhook } from '@/lib/telegram-api';
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
//
// After saving, calls Telegram's setWebhook directly (lib/telegram-api.ts)
// — the token is still in memory here, unencrypted, right after getMe
// validated it, so the portal registers the webhook itself instead of
// handing the raw token to n8n over the wire. The webhook URL is
// per-connection (N8N_TELEGRAM_WEBHOOK_BASE_URL/<connectionId>), which
// is how the multi-tenant n8n workflow tells which client an incoming
// Telegram update belongs to. A setWebhook failure doesn't fail the
// whole request — the credential IS valid (getMe already proved that)
// — it's recorded as lastSyncError so the operator sees it
// (/admin/portal/[clientId], Fase 5) and the client isn't left thinking
// their token was rejected.
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

  const webhookBaseUrl = process.env.N8N_TELEGRAM_WEBHOOK_BASE_URL;
  let webhookWarning = false;
  if (webhookBaseUrl) {
    const webhookResult = await setWebhook(botToken, `${webhookBaseUrl.replace(/\/$/, '')}/${connection.id}`);
    if (!webhookResult.ok) {
      webhookWarning = true;
      await prisma.telegramConnection
        .update({ where: { id: connection.id }, data: { lastSyncError: webhookResult.error.slice(0, 500) } })
        .catch(() => null);
      logError('channels.telegram_connect.set_webhook_failed', new Error(webhookResult.error), { clientId: resolved.clientId, connectionId: connection.id }, 'warn');
    }
  } else {
    webhookWarning = true;
    logError('channels.telegram_connect.webhook_base_url_unset', new Error('N8N_TELEGRAM_WEBHOOK_BASE_URL is not configured'), { clientId: resolved.clientId }, 'warn');
  }

  // Fire-and-persist: deliverChannelEvent always audits the attempt
  // (ChannelWebhookDelivery) and never throws — an awareness signal for
  // n8n, not what makes the channel work (setWebhook above already did
  // that).
  await deliverChannelEvent({
    connectionType: 'telegram',
    connectionId: connection.id,
    clientId: resolved.clientId,
    payload: { event: 'connected', botUsername },
  });

  return NextResponse.json({ ok: true, botUsername, status: 'active', webhookWarning });
}
