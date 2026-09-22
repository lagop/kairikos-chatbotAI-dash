import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { resolveContractedInstance } from '@/lib/client-product-access';
import { getAllowedChannelsForClient, type ChannelCode } from '@/lib/channel-access';
import {
  isMetaSignupConfigured,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  inspectAccessToken,
  fetchPagesWithInstagram,
  encryptMetaToken,
} from '@/lib/meta-business';
import { resolveTokenExpiry, isUnusableToken } from '@/lib/meta-token-expiry';
import { subscribeWaba, getPhoneNumberInfo, getPhoneNumbersForWaba } from '@/lib/whatsapp-api';
import { subscribePage } from '@/lib/messenger-api';
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

// Los ids de Meta son numéricos. Se exige aquí porque wabaId acaba dentro de
// una ruta de la Graph API (`/<wabaId>/phone_numbers`).
const META_ID = z.string().regex(/^[0-9]{1,32}$/);

const BodySchema = z.object({
  code: z.string().min(1, 'required'),
  whatsapp: z.object({ wabaId: META_ID, phoneNumberId: META_ID }).optional(),
  // Fase 4 multi-instancia — a qué chatbot se conectan estas superficies.
  // Opcional: sin él, solo vale si el cliente tiene un chatbot.
  clientProductId: z.string().uuid().optional(),
});

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }
  if (!(await isMetaSignupConfigured())) {
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

  const instance = await resolveContractedInstance(prisma, {
    clientId: resolved.clientId,
    productCode: 'chatbot',
    clientProductId: body.data.clientProductId ?? null,
  });
  if (!instance) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  // Capturado aquí: la función upsertSurface de más abajo es un cierre y
  // TypeScript no conserva ahí el estrechamiento de `instance`.
  const chatbotProductId = instance.clientProductId;

  // La tarifa que cuenta es la de ESTE chatbot: con un Starter y un Premium,
  // conectar WhatsApp al Starter no debe salir bien por leer la del otro.
  const allowedChannels = await getAllowedChannelsForClient(prisma, resolved.clientId, instance.clientProductId);
  if (!allowedChannels.some((c) => META_CHANNELS.includes(c))) {
    return NextResponse.json({ error: 'channel_not_in_plan' }, { status: 403 });
  }

  const shortLived = await exchangeCodeForToken(body.data.code);
  if (!shortLived) {
    return NextResponse.json({ error: 'meta_api_error', detail: 'code_exchange_failed' }, { status: 502 });
  }
  const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
  const accessToken = longLived?.accessToken ?? shortLived.accessToken;
  // WP-XX — Meta has always returned this and the portal has always
  // thrown it away, so nothing knew when a connection was going to die.
  // Long-lived tokens last ~60 days; for a product that sends on a
  // schedule, an unnoticed expiry is a silent outage for that client.
  const expiresIn = longLived?.expiresIn ?? shortLived.expiresIn;
  // 2026-09-15 — `expires_in` ausente no significa "no caduca". La fecha
  // real sale de /debug_token, y un token de corta duración no se guarda
  // (ver meta-token-expiry.ts).
  const now = new Date();
  const inspected = await inspectAccessToken(accessToken);
  const tokenExpiresAt = resolveTokenExpiry({ inspected, expiresIn, now });
  if (isUnusableToken({ inspected, expiresAt: tokenExpiresAt, now })) {
    return NextResponse.json({ error: 'meta_api_error', detail: 'short_lived_token' }, { status: 502 });
  }

  // Seguridad (22/09/2026) — el número y la cuenta de WhatsApp llegan en el
  // cuerpo, que escribe el navegador. Hasta hoy se guardaban tal cual: un
  // cliente con chatbot podía hacer su propio alta y mandar el
  // phone_number_id de OTRO negocio, y los mensajes que entran a ese número
  // podían acabar en su bandeja (las rutas internas buscan la conexión solo
  // por ese id). Se comprueba con el token recién emitido, que solo ve las
  // cuentas de quien acaba de pasar por el popup de Meta: la misma
  // comprobación que ya hacía recall (recall-meta.ts, phone_not_in_waba).
  // Si la tarifa no incluye WhatsApp, upsertSurface lo va a bloquear igual y
  // no hay nada que comprobar.
  if (body.data.whatsapp && allowedChannels.includes('whatsapp')) {
    const { wabaId, phoneNumberId } = body.data.whatsapp;
    const numbers = await getPhoneNumbersForWaba(accessToken, wabaId);
    if (!numbers.ok) {
      return NextResponse.json({ error: 'meta_api_error', detail: 'waba_not_accessible' }, { status: 502 });
    }
    if (!(numbers.data.data ?? []).some((n) => n.id === phoneNumberId)) {
      return NextResponse.json({ error: 'phone_not_in_waba' }, { status: 400 });
    }
    // Un número solo puede servir a un cliente: si otro lo tiene activo, las
    // rutas internas elegirían entre los dos según el orden de Postgres.
    // Aunque quien conecta demuestre que es suyo, se para aquí y lo resuelve
    // soporte, en vez de partir los mensajes entre dos cuentas en silencio.
    const takenElsewhere = await prisma.metaChannelConnection.findFirst({
      where: { channel: 'whatsapp', externalId: phoneNumberId, status: 'active', NOT: { clientId: resolved.clientId } },
      select: { id: true },
    });
    if (takenElsewhere) {
      logError('channels.meta_complete_signup.number_owned_by_other_client', new Error('whatsapp_number_in_use'), { clientId: resolved.clientId, phoneNumberId }, 'warn');
      return NextResponse.json({ error: 'whatsapp_number_in_use' }, { status: 409 });
    }
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { tenantId: true },
  });

  const clientId = resolved.clientId;
  const connected: Array<{ channel: ChannelCode; externalId: string; label: string }> = [];
  const blocked: ChannelCode[] = [];

  async function upsertSurface(
    channel: ChannelCode,
    externalId: string,
    label: string,
    wabaId: string | null = null,
    subscribePageId: string | null = null,
  ) {
    if (!allowedChannels.includes(channel)) {
      blocked.push(channel);
      return;
    }
    const encrypted = encryptMetaToken(accessToken);
    const connection = await prisma.metaChannelConnection.upsert({
      where: { clientId_channel_externalId: { clientId, channel, externalId } },
      update: {
        // Fase 4 multi-instancia — la unicidad es una superficie por cliente
        // (un número, una página): conectarla desde el chatbot B la pasa a
        // servir al B aunque antes sirviera al A. Es lo que expresa el gesto,
        // y un mismo número no puede contestar con dos bots.
        clientProductId: chatbotProductId,
        label,
        wabaId,
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenIv: encrypted.iv,
        accessTokenTag: encrypted.tag,
        status: 'active',
        lastSyncError: null,
        tokenExpiresAt,
        // A reconnect resets the warning: this is a fresh token with a
        // fresh clock, and the operator should be told again when THIS
        // one is about to die.
        expiryWarnedAt: null,
      },
      create: {
        clientId,
        // El ancla desde la que las rutas internas sabrán qué bot contesta.
        clientProductId: chatbotProductId,
        tenantId: client?.tenantId ?? null,
        channel,
        externalId,
        label,
        wabaId,
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenIv: encrypted.iv,
        accessTokenTag: encrypted.tag,
        status: 'active',
        tokenExpiresAt,
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

      // WP-XX — resolve what the client's number ACTUALLY is. Until now
      // the row only ever held phone_number_id and a label of
      // 'WhatsApp (<wabaId>)', so no support conversation could answer
      // "which number is this client sending from". Best-effort for the
      // same reason as the subscription above: the connection succeeded,
      // and a missing display name must not fail it.
      const info = await getPhoneNumberInfo(accessToken, externalId);
      if (info.ok) {
        await prisma.metaChannelConnection
          .update({
            where: { id: connection.id },
            data: {
              displayPhoneNumber: info.data.display_phone_number ?? null,
              verifiedName: info.data.verified_name ?? null,
              qualityRating: info.data.quality_rating ?? null,
              // Now that the real number is known, label it with that
              // rather than the WABA id nobody can read.
              ...(info.data.display_phone_number
                ? { label: `WhatsApp ${info.data.display_phone_number}` }
                : {}),
            },
          })
          .catch(() => null);
      }
    }

    // Messenger AND Instagram both ride on the same Page-level
    // subscription (see messenger-api.ts's comment) — messenger's
    // subscribePageId is the page itself (externalId); instagram's is
    // the page that owns it, passed in separately since externalId for
    // an instagram row is the IG account id, not the page id. Calling
    // this twice for the same page (once per surface) is harmless —
    // subscribed_apps is idempotent.
    if ((channel === 'messenger' || channel === 'instagram') && subscribePageId) {
      const subscribeResult = await subscribePage(accessToken, subscribePageId);
      if (!subscribeResult.ok) {
        await prisma.metaChannelConnection
          .update({ where: { id: connection.id }, data: { lastSyncError: subscribeResult.error.slice(0, 500) } })
          .catch(() => null);
        logError('channels.meta_complete_signup.subscribe_page_failed', new Error(subscribeResult.error), { clientId, subscribePageId }, 'warn');
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
      await upsertSurface('messenger', page.pageId, page.pageName, null, page.pageId);
      if (page.instagramAccountId) {
        await upsertSurface('instagram', page.instagramAccountId, page.pageName, null, page.pageId);
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
