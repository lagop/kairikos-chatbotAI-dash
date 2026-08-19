import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { getAllowedChannelsForClient, type ChannelCode } from '@/lib/channel-access';
import {
  isMetaSignupConfigured,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchPagesWithInstagram,
  encryptMetaToken,
} from '@/lib/meta-business';
import { subscribeWaba } from '@/lib/whatsapp-api';
import { deliverChannelEvent } from '@/lib/channel-webhook';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const META_CHANNELS: readonly ChannelCode[] = ['whatsapp', 'messenger', 'instagram'];

// =============================================================================
// WP: conexión de canales — POST /api/portal/channels/meta/complete-signup
//
// Not an OAuth redirect callback — the client-side JS SDK
// (MetaChannelCard.tsx) runs WhatsApp Embedded Signup in a popup and
// posts the resulting `code` here directly, along with the WABA/phone
// number Meta's own UI resolved during that popup (if the client went
// through the WhatsApp-specific signup step; Messenger/Instagram-only
// connections omit `whatsapp`).
//
// Auto-connects every surface this token can reach AND the client's
// tier allows — no manual picker for Messenger/Instagram Pages in this
// pass (the plan called for a selector when multiple surfaces are
// found; skipped as a deliberate scope cut, documented in the PR, since
// most SMB clients have exactly one Facebook Page and a stateful
// multi-step picker adds real complexity for a case this code has no
// way to verify live against a real Meta App anyway).
// =============================================================================

const BodySchema = z.object({
  code: z.string().min(1, 'required'),
  whatsapp: z.object({ wabaId: z.string().min(1), phoneNumberId: z.string().min(1) }).optional(),
});

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  if (!isMetaSignupConfigured()) {
    return NextResponse.json({ error: 'not_configured' }, { status: 503 });
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

  const allowedChannels = await getAllowedChannelsForClient(prisma, resolved.clientId);
  if (!allowedChannels.some((c) => META_CHANNELS.includes(c))) {
    return NextResponse.json({ error: 'channel_not_in_plan' }, { status: 403 });
  }

  const shortLived = await exchangeCodeForToken(body.data.code);
  if (!shortLived) {
    return NextResponse.json({ error: 'meta_api_error', detail: 'code_exchange_failed' }, { status: 502 });
  }
  const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
  const accessToken = longLived?.accessToken ?? shortLived.accessToken;

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { tenantId: true },
  });

  const clientId = resolved.clientId;
  const connected: Array<{ channel: ChannelCode; externalId: string; label: string }> = [];
  const blocked: ChannelCode[] = [];

  async function upsertSurface(channel: ChannelCode, externalId: string, label: string, wabaId: string | null = null) {
    if (!allowedChannels.includes(channel)) {
      blocked.push(channel);
      return;
    }
    const encrypted = encryptMetaToken(accessToken);
    const connection = await prisma.metaChannelConnection.upsert({
      where: { clientId_channel_externalId: { clientId, channel, externalId } },
      update: {
        label,
        wabaId,
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenIv: encrypted.iv,
        accessTokenTag: encrypted.tag,
        status: 'active',
        lastSyncError: null,
      },
      create: {
        clientId,
        tenantId: client?.tenantId ?? null,
        channel,
        externalId,
        label,
        wabaId,
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenIv: encrypted.iv,
        accessTokenTag: encrypted.tag,
        status: 'active',
      },
    });

    // WhatsApp's app-level webhook (configured once in the Meta App
    // Dashboard, external to this repo) only delivers messages for a
    // WABA that has explicitly subscribed the app — this is that
    // subscription. A failure here doesn't unwind the connection (the
    // token IS valid, connecting DID succeed) — same "never leaves the
    // client thinking they were rejected" posture as Telegram's
    // setWebhook — it's recorded as lastSyncError instead.
    if (channel === 'whatsapp' && wabaId) {
      const subscribeResult = await subscribeWaba(accessToken, wabaId);
      if (!subscribeResult.ok) {
        await prisma.metaChannelConnection
          .update({ where: { id: connection.id }, data: { lastSyncError: subscribeResult.error.slice(0, 500) } })
          .catch(() => null);
        logError('channels.meta_complete_signup.subscribe_waba_failed', new Error(subscribeResult.error), { clientId, wabaId }, 'warn');
      }
    }

    connected.push({ channel, externalId, label });
    await deliverChannelEvent({
      connectionType: 'meta',
      connectionId: connection.id,
      clientId,
      payload: { event: 'connected', channel, externalId, label },
    });
  }

  try {
    if (body.data.whatsapp) {
      await upsertSurface(
        'whatsapp',
        body.data.whatsapp.phoneNumberId,
        `WhatsApp (${body.data.whatsapp.wabaId})`,
        body.data.whatsapp.wabaId,
      );
    }

    const pages = await fetchPagesWithInstagram(accessToken);
    for (const page of pages) {
      await upsertSurface('messenger', page.pageId, page.pageName);
      if (page.instagramAccountId) {
        await upsertSurface('instagram', page.instagramAccountId, page.pageName);
      }
    }
  } catch (err) {
    logError('channels.meta_complete_signup.persist_failed', err, { clientId: resolved.clientId }, 'warn');
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  if (connected.length === 0) {
    return NextResponse.json({ error: 'no_surfaces_connected', blocked }, { status: 409 });
  }

  return NextResponse.json({ ok: true, connected, blocked });
}
