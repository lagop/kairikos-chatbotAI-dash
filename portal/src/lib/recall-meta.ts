import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { canBindMetaConnection, nextOnboardingStatus } from './recall';
import { exchangeCodeForToken, exchangeForLongLivedToken, encryptMetaToken } from './meta-business';
import { subscribeWaba, getPhoneNumbersForWaba, getPhoneNumberInfo, syncSmbAppState } from './whatsapp-api';
import { deliverChannelEvent } from './channel-webhook';
import { logError } from './observability';

// =============================================================================
// Fase 8 ('recall') — Coexistence connect.
//
// Deliberately its own module rather than a branch inside
// api/portal/channels/meta/complete-signup: that route's authorization
// (chatbot tier → allowed channels), its multi-surface fan-out (one
// `code` can yield Messenger AND Instagram pages alongside WhatsApp), and
// its post-conditions (nothing to bind, nothing to advance) all answer a
// different question than this one does. Threading recall's rules
// through that route would mean gating an unrelated product's flow on
// getAllowedChannelsForClient() — chatbot-tier channel entitlements have
// nothing to say about whether a recall client's number came correctly
// off the pool. Same reasoning that gave recall its own numbers/audit/
// queue modules instead of reusing chatbot's.
//
// What THIS flow guarantees that the chatbot one does not, and must not,
// attempt: exactly one WhatsApp number, connected via the coexistence
// Configuration, bound to exactly one RecallSubscription, advancing its
// state machine — see recall.ts's canBindMetaConnection.
//
// UNVERIFIED AGAINST A REAL META APP — same standing caveat as
// meta-business.ts, sourced against Meta's current published docs (see
// that file's header) rather than tested live.
// =============================================================================

export type ConnectRecallWhatsappResult =
  | {
      ok: true;
      connectionId: string;
      displayPhoneNumber: string | null;
      advancedTo: string | null;
    }
  | {
      ok: false;
      error:
        | 'subscription_not_found'
        | 'invalid_status'
        | 'code_exchange_failed'
        | 'phone_number_not_found'
        | 'persist_failed';
    };

/**
 * Completes the coexistence popup's handoff for one recall subscription:
 * exchanges the code, resolves the phone number id (the coexistence
 * FINISH event never carries one — see meta-business.ts), stores the
 * connection with isCoexistence=true, subscribes the WABA to the app
 * webhook, starts the one-time contacts/history sync, and — the part
 * that was missing entirely before this — binds the connection to the
 * subscription and advances its status, exactly the way
 * assignNumberToSubscription binds a virtual number.
 *
 * NEVER calls POST /{phone_number_id}/register. Coexistence explicitly
 * forbids it: the number is already registered via the app. This is the
 * one Meta-activation step this module does NOT hand off to n8n — see
 * meta-business.ts's header for why.
 */
export async function connectRecallWhatsapp(
  prisma: PrismaClient,
  params: {
    clientId: string;
    tenantId: string | null;
    subscriptionId: string;
    code: string;
    wabaId: string;
  },
): Promise<ConnectRecallWhatsappResult> {
  const subscription = await prisma.recallSubscription.findUnique({
    where: { id: params.subscriptionId },
    select: { id: true, clientId: true, status: true },
  });
  if (!subscription || subscription.clientId !== params.clientId) {
    return { ok: false, error: 'subscription_not_found' };
  }
  if (!canBindMetaConnection(subscription.status)) {
    return { ok: false, error: 'invalid_status' };
  }

  const shortLived = await exchangeCodeForToken(params.code);
  if (!shortLived) return { ok: false, error: 'code_exchange_failed' };
  const longLived = await exchangeForLongLivedToken(shortLived.accessToken);
  const accessToken = longLived?.accessToken ?? shortLived.accessToken;
  const expiresIn = longLived?.expiresIn ?? shortLived.expiresIn;
  const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  const numbers = await getPhoneNumbersForWaba(accessToken, params.wabaId);
  const phoneNumberId = numbers.ok ? numbers.data.data?.[0]?.id : undefined;
  if (!phoneNumberId) {
    logError(
      'recall_meta.resolve_phone_number_failed',
      new Error(numbers.ok ? 'no phone numbers on waba' : numbers.error),
      { subscriptionId: params.subscriptionId, wabaId: params.wabaId },
      'warn',
    );
    return { ok: false, error: 'phone_number_not_found' };
  }

  const encrypted = encryptMetaToken(accessToken);
  let connectionId: string;
  try {
    const connection = await prisma.metaChannelConnection.upsert({
      where: {
        clientId_channel_externalId: { clientId: params.clientId, channel: 'whatsapp', externalId: phoneNumberId },
      },
      update: {
        label: `WhatsApp ${phoneNumberId}`,
        wabaId: params.wabaId,
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenIv: encrypted.iv,
        accessTokenTag: encrypted.tag,
        status: 'active',
        lastSyncError: null,
        tokenExpiresAt,
        expiryWarnedAt: null,
        isCoexistence: true,
      },
      create: {
        clientId: params.clientId,
        tenantId: params.tenantId,
        channel: 'whatsapp',
        externalId: phoneNumberId,
        label: `WhatsApp ${phoneNumberId}`,
        wabaId: params.wabaId,
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenIv: encrypted.iv,
        accessTokenTag: encrypted.tag,
        status: 'active',
        tokenExpiresAt,
        isCoexistence: true,
      },
    });
    connectionId = connection.id;
  } catch (err) {
    logError('recall_meta.persist_connection_failed', err, { subscriptionId: params.subscriptionId }, 'warn');
    return { ok: false, error: 'persist_failed' };
  }

  // Best-effort from here on — the connection IS valid and IS bound
  // below regardless of whether these succeed. Same posture as
  // complete-signup's upsertSurface: a subscription failure or a slow
  // sync must not read to the client as "connecting failed".
  const subscribeResult = await subscribeWaba(accessToken, params.wabaId);
  if (!subscribeResult.ok) {
    await prisma.metaChannelConnection
      .update({ where: { id: connectionId }, data: { lastSyncError: subscribeResult.error.slice(0, 500) } })
      .catch(() => null);
    logError('recall_meta.subscribe_waba_failed', new Error(subscribeResult.error), { connectionId }, 'warn');
  }

  const info = await getPhoneNumberInfo(accessToken, phoneNumberId);
  let displayPhoneNumber: string | null = null;
  if (info.ok) {
    displayPhoneNumber = info.data.display_phone_number ?? null;
    await prisma.metaChannelConnection
      .update({
        where: { id: connectionId },
        data: {
          displayPhoneNumber,
          verifiedName: info.data.verified_name ?? null,
          qualityRating: info.data.quality_rating ?? null,
          platformType: info.data.platform_type ?? null,
          ...(displayPhoneNumber ? { label: `WhatsApp ${displayPhoneNumber}` } : {}),
        },
      })
      .catch(() => null);
  }

  const syncResult = await syncSmbAppState(accessToken, phoneNumberId);
  if (!syncResult.ok) {
    logError('recall_meta.smb_app_state_sync_failed', new Error(syncResult.error), { connectionId }, 'warn');
  }

  // The bind + advance, in one write: this is the step that was entirely
  // absent before this module — canBindMetaConnection existed, nothing
  // called it. Advancing only when the subscription is still exactly one
  // step behind mirrors assignNumberToSubscription's care not to move a
  // status backward or sideways on a reconnect (a client whose token
  // expired and reconnects months later must not be pushed back through
  // number_assigned/templates_approved again).
  const advanceTo = nextOnboardingStatus(subscription.status);
  const willAdvance = advanceTo === 'meta_connected';
  const before = { status: subscription.status, metaConnectionId: null };
  const updated = await prisma.recallSubscription.update({
    where: { id: subscription.id },
    data: {
      metaConnectionId: connectionId,
      ...(willAdvance ? { status: 'meta_connected', metaConnectedAt: new Date() } : {}),
    },
    select: { status: true },
  });

  await prisma.recallSubscriptionAudit
    .create({
      data: {
        subscriptionId: subscription.id,
        clientId: params.clientId,
        action: 'meta_connected',
        before,
        after: { status: updated.status, metaConnectionId: connectionId, isCoexistence: true },
        actorType: 'client',
        actorEmail: `client:${params.clientId}`,
      },
    })
    // Connected and bound either way — an audit-insert failure must not
    // read to the client as "connecting failed". Same posture as
    // recall-numbers.ts's assignNumberToSubscription.
    .catch(() => null);

  await deliverChannelEvent({
    connectionType: 'meta',
    connectionId,
    clientId: params.clientId,
    payload: {
      event: 'connected',
      channel: 'whatsapp',
      externalId: phoneNumberId,
      // The one bit n8n's activation workflow needs to NOT call
      // POST /register against this number.
      isCoexistence: true,
    },
  }).catch(() => null);

  return {
    ok: true,
    connectionId,
    displayPhoneNumber,
    advancedTo: willAdvance ? 'meta_connected' : null,
  };
}
