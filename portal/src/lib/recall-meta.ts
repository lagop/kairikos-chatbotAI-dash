import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { canBindMetaConnection, nextOnboardingStatus } from './recall';
import { exchangeCodeForToken, exchangeForLongLivedToken, inspectAccessToken, encryptMetaToken } from './meta-business';
import { resolveTokenExpiry, isUnusableToken } from './meta-token-expiry';
import { subscribeWaba, getPhoneNumbersForWaba, getPhoneNumberInfo, syncSmbAppState } from './whatsapp-api';
import { submitAllRecallTemplates, sendForwardingInstructions, type TemplateSubmissionOutcome } from './recall-templates';
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
      /** Only attempted on the WABA's first connect — see the submission
       *  call below. Null on a reconnect, where the WABA's templates from
       *  its original connect already exist. */
      templatesSubmitted: TemplateSubmissionOutcome[] | null;
    }
  | {
      ok: false;
      error:
        | 'subscription_not_found'
        | 'invalid_status'
        | 'code_exchange_failed'
        | 'short_lived_token'
        | 'phone_number_not_found'
        | 'persist_failed';
    };

/**
 * Completes the coexistence popup's handoff for one recall subscription:
 * exchanges the code, resolves the phone number id (the coexistence
 * FINISH event never carries one — see meta-business.ts), stores the
 * connection with isCoexistence=true, subscribes the WABA to the app
 * webhook, starts the one-time contacts/history sync, submits this
 * client's 6 WhatsApp templates for Meta's review on a first connect
 * (see recall-templates.ts), and — the part that was missing entirely
 * before this — binds the connection to the subscription and advances
 * its status, exactly the way assignNumberToSubscription binds a virtual
 * number.
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
  // Ver meta-token-expiry.ts: el único negocio en producción se conectó
  // con un token de ~1 hora guardado como "no caduca".
  const now = new Date();
  const inspected = await inspectAccessToken(accessToken);
  const tokenExpiresAt = resolveTokenExpiry({ inspected, expiresIn, now });
  if (isUnusableToken({ inspected, expiresAt: tokenExpiresAt, now })) {
    logError(
      'recall_meta.short_lived_token',
      new Error('Meta devolvió un token inválido o de corta duración'),
      {
        subscriptionId: params.subscriptionId,
        longLivedExchanged: Boolean(longLived),
        tokenType: inspected?.type ?? null,
        expiresAt: tokenExpiresAt?.toISOString() ?? null,
      },
      'error',
    );
    return { ok: false, error: 'short_lived_token' };
  }

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

  return bindRecallMetaConnection(prisma, {
    subscription,
    clientId: params.clientId,
    tenantId: params.tenantId,
    accessToken,
    tokenExpiresAt,
    wabaId: params.wabaId,
    phoneNumberId,
    mode: 'coexistence',
    actor: { type: 'client', clientId: params.clientId },
  });
}

export interface BindRecallMetaConnectionInput {
  subscription: { id: string; clientId: string; status: string };
  clientId: string;
  tenantId: string | null;
  accessToken: string;
  tokenExpiresAt: Date | null;
  wabaId: string;
  phoneNumberId: string;
  /** 'coexistence' = alta del cliente con su app del móvil; 'manual' =
   *  conexión que pega el operador (número solo en la Cloud API). */
  mode: 'coexistence' | 'manual';
  actor: { type: 'client'; clientId: string } | { type: 'operator'; operatorId: string; email: string | null };
}

/**
 * Guarda la conexión, suscribe la WABA, rellena los datos del número y
 * vincula la suscripción. Compartido por el alta de Coexistence y la conexión
 * manual del operador (2026-09-17) para que las dos no diverjan.
 */
export async function bindRecallMetaConnection(
  prisma: PrismaClient,
  input: BindRecallMetaConnectionInput,
): Promise<ConnectRecallWhatsappResult> {
  const { subscription, accessToken, tokenExpiresAt, phoneNumberId } = input;
  const isCoexistence = input.mode === 'coexistence';
  const encrypted = encryptMetaToken(accessToken);
  let connectionId: string;
  try {
    const connection = await prisma.metaChannelConnection.upsert({
      where: {
        clientId_channel_externalId: { clientId: input.clientId, channel: 'whatsapp', externalId: phoneNumberId },
      },
      update: {
        label: `WhatsApp ${phoneNumberId}`,
        wabaId: input.wabaId,
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenIv: encrypted.iv,
        accessTokenTag: encrypted.tag,
        status: 'active',
        lastSyncError: null,
        tokenExpiresAt,
        expiryWarnedAt: null,
        isCoexistence,
      },
      create: {
        clientId: input.clientId,
        tenantId: input.tenantId,
        channel: 'whatsapp',
        externalId: phoneNumberId,
        label: `WhatsApp ${phoneNumberId}`,
        wabaId: input.wabaId,
        accessTokenCiphertext: encrypted.ciphertext,
        accessTokenIv: encrypted.iv,
        accessTokenTag: encrypted.tag,
        status: 'active',
        tokenExpiresAt,
        isCoexistence,
      },
    });
    connectionId = connection.id;
  } catch (err) {
    logError('recall_meta.persist_connection_failed', err, { subscriptionId: subscription.id }, 'warn');
    return { ok: false, error: 'persist_failed' };
  }

  // Best-effort from here on — the connection IS valid and IS bound
  // below regardless of whether these succeed. Same posture as
  // complete-signup's upsertSurface: a subscription failure or a slow
  // sync must not read to the client as "connecting failed".
  const subscribeResult = await subscribeWaba(accessToken, input.wabaId);
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

  // Solo Coexistence: sincroniza contactos e historial de la app del móvil.
  // Un número que solo vive en la Cloud API no tiene app que sincronizar.
  if (isCoexistence) {
    const syncResult = await syncSmbAppState(accessToken, phoneNumberId);
    if (!syncResult.ok) {
      logError('recall_meta.smb_app_state_sync_failed', new Error(syncResult.error), { connectionId }, 'warn');
    }
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

  // Submitting templates is safe to redo (Meta just re-reports "already
  // exists"), but pointless on a reconnect — the WABA is unchanged, so
  // its templates from the original connect are already there. Gated on
  // willAdvance rather than run unconditionally like subscribeWaba/
  // syncSmbAppState above, which stay useful to repeat every time.
  let templatesSubmitted: TemplateSubmissionOutcome[] | null = null;
  if (willAdvance) {
    templatesSubmitted = await submitAllRecallTemplates(accessToken, input.wabaId);
  }

  // 2026-09-17 — un alta que ya esperaba el desvío y reconecta su WhatsApp
  // (tras caducar el acceso, o a mano) no había recibido los códigos: el
  // envío se saltó mientras la conexión estaba caída. Ahora que hay con qué
  // enviarlos, se envían. Nunca lanza.
  if (updated.status === 'forwarding_pending') {
    const bound = await prisma.recallSubscription
      .findUnique({
        where: { id: subscription.id },
        select: {
          id: true,
          clientId: true,
          tenantId: true,
          ownerWhatsapp: true,
          virtualNumber: { select: { e164: true } },
          metaConnection: {
            select: {
              id: true,
              externalId: true,
              status: true,
              accessTokenCiphertext: true,
              accessTokenIv: true,
              accessTokenTag: true,
            },
          },
        },
      })
      .catch(() => null);
    if (bound?.ownerWhatsapp) await sendForwardingInstructions(prisma, bound);
  }

  await prisma.recallSubscriptionAudit
    .create({
      data: {
        subscriptionId: subscription.id,
        clientId: input.clientId,
        action: 'meta_connected',
        before,
        after: {
          status: updated.status,
          metaConnectionId: connectionId,
          isCoexistence,
          mode: input.mode,
          templatesSubmitted: templatesSubmitted?.map((t) => ({ name: t.name, ok: t.ok })) ?? null,
        },
        ...(input.actor.type === 'client'
          ? { actorType: 'client', actorEmail: `client:${input.actor.clientId}` }
          : { actorType: 'operator', actorOperatorId: input.actor.operatorId, actorEmail: input.actor.email }),
      },
    })
    // Connected and bound either way — an audit-insert failure must not
    // read to the client as "connecting failed". Same posture as
    // recall-numbers.ts's assignNumberToSubscription.
    .catch(() => null);

  await deliverChannelEvent({
    connectionType: 'meta',
    connectionId,
    clientId: input.clientId,
    payload: {
      event: 'connected',
      channel: 'whatsapp',
      externalId: phoneNumberId,
      // The one bit n8n's activation workflow needs to NOT call
      // POST /register against this number.
      isCoexistence,
      // Conexión manual: el número ya lo registró el operador en Meta.
      ...(input.mode === 'manual' ? { manual: true } : {}),
    },
  }).catch(() => null);

  return {
    ok: true,
    connectionId,
    displayPhoneNumber,
    advancedTo: willAdvance ? 'meta_connected' : null,
    templatesSubmitted,
  };
}


// =============================================================================
// 2026-09-17 — conexión MANUAL de WhatsApp por el operador.
//
// El registro insertado de Meta (FB.login) solo funciona cuando la app es
// Tech Provider; hasta que Meta lo apruebe, Meta responde "no puede registrar
// clientes en este momento". Para no bloquear la prueba de principio a fin,
// el operador puede pegar tres datos de una cuenta de WhatsApp Business que
// controle él mismo: el ID de la WABA, el ID del número y un token de usuario
// del sistema creado en su Business Manager (no caduca).
//
// Limitación aceptada: ese número vive en la Cloud API, no en la app del móvil
// a la vez (eso es Coexistence). Por eso la conexión se guarda con
// isCoexistence=false y no se llama a syncSmbAppState. Tampoco se llama a
// POST /register: el número tiene que estar ya registrado en Meta.
//
// Antes de guardar se comprueba contra Meta todo lo que, mal puesto, haría
// fallar en silencio el primer envío: token válido, que no caduque pronto,
// con los dos permisos de WhatsApp, y que el número sea de esa WABA.
// =============================================================================

export const REQUIRED_WHATSAPP_SCOPES = ['whatsapp_business_management', 'whatsapp_business_messaging'] as const;

export type ConnectManualResult =
  | ConnectRecallWhatsappResult
  | {
      ok: false;
      error: 'token_not_verifiable' | 'token_invalid' | 'missing_permissions' | 'waba_not_accessible' | 'phone_not_in_waba';
      detail?: string;
    };

export async function connectRecallWhatsappManually(
  prisma: PrismaClient,
  params: {
    subscriptionId: string;
    wabaId: string;
    phoneNumberId: string;
    accessToken: string;
    operator: { operatorId: string; email: string | null };
    now?: Date;
  },
): Promise<ConnectManualResult> {
  const subscription = await prisma.recallSubscription.findUnique({
    where: { id: params.subscriptionId },
    select: { id: true, clientId: true, status: true, client: { select: { tenantId: true } } },
  });
  if (!subscription) return { ok: false, error: 'subscription_not_found' };
  if (!canBindMetaConnection(subscription.status)) return { ok: false, error: 'invalid_status' };

  const now = params.now ?? new Date();
  const inspected = await inspectAccessToken(params.accessToken);
  // Sin poder preguntar a Meta no se guarda: es la única comprobación de que
  // el token pegado sirve, y guardar uno roto es lo que dejó a producción un
  // día sin WhatsApp.
  if (!inspected) return { ok: false, error: 'token_not_verifiable' };
  const tokenExpiresAt = resolveTokenExpiry({ inspected, expiresIn: null, now });
  if (!inspected.isValid) return { ok: false, error: 'token_invalid' };
  if (isUnusableToken({ inspected, expiresAt: tokenExpiresAt, now })) {
    return { ok: false, error: 'short_lived_token' };
  }
  const missing = REQUIRED_WHATSAPP_SCOPES.filter((scope) => !inspected.scopes.includes(scope));
  if (missing.length > 0) return { ok: false, error: 'missing_permissions', detail: missing.join(', ') };

  const numbers = await getPhoneNumbersForWaba(params.accessToken, params.wabaId);
  if (!numbers.ok) return { ok: false, error: 'waba_not_accessible', detail: numbers.error.slice(0, 200) };
  if (!(numbers.data.data ?? []).some((n) => n.id === params.phoneNumberId)) {
    return { ok: false, error: 'phone_not_in_waba' };
  }

  const result = await bindRecallMetaConnection(prisma, {
    subscription,
    clientId: subscription.clientId,
    tenantId: subscription.client.tenantId,
    accessToken: params.accessToken,
    tokenExpiresAt,
    wabaId: params.wabaId,
    phoneNumberId: params.phoneNumberId,
    mode: 'manual',
    actor: { type: 'operator', operatorId: params.operator.operatorId, email: params.operator.email },
  });
  if (result.ok) {
    logError(
      'recall_meta.manual_connection',
      new Error('conexión de WhatsApp creada a mano por un operador'),
      { subscriptionId: subscription.id, connectionId: result.connectionId, tokenType: inspected.type },
      'warn',
    );
  }
  return result;
}
