import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { sendTemplate } from './whatsapp-api';
import { metaSenderFor, type MetaSender } from './recall-messaging';
import {
  DIGEST_TEMPLATES,
  DIGEST_REPLY_WINDOW_HOURS,
  MAX_DIGEST_ATTEMPTS,
  buildDigestList,
  callIdsOf,
  isDigestDue,
  listDigestCalls,
  localDateFor,
  parseDigestReply,
  resolveSelection,
  startOfLocalDay,
  type DigestCall,
} from './recall-digest';
import {
  createCampaignWithRequests,
  dispatchReviewRequest,
  type WhatsAppSenderCredentials,
} from './review-request-campaign';
import { logError } from './observability';

// =============================================================================
// WP-XX (Fase 10) — the review half, over WhatsApp.
//
// Three jobs, all driven by the same tick:
//
//   sendDailyDigests()      19:00-ish: "these are today's calls, which
//                           became a job?"
//   applyDigestReply()      the owner answers; the ones he names get a
//                           review invitation.
//   sweepReviewReminders()  four days later, ONE nudge to anyone who
//                           never opened the link.
//
// The review request itself reuses ReviewRequestCampaign / ReviewRequest
// unchanged — the campaign, the /r/{id} tracking link and the
// pending|sent|failed machine were already channel-agnostic, so this adds
// a channel rather than a parallel system. That also means the reviews
// product's existing operator screens show these with no extra work.
//
// Nothing here can filter by satisfaction. There is no column for it and
// no argument that carries it; the owner is asked WHO HE SERVED, and
// every one of those gets the identical invitation.
// =============================================================================

/** Days before the single reminder. Long enough that it does not read as
 *  nagging, short enough that the job is still fresh in the customer's
 *  mind — after about a week the request stops making sense at all. */
export const REVIEW_REMINDER_DAYS = 4;

/** Beyond this the reminder is pointless and starts to feel like spam, so
 *  an old backlog is skipped rather than blasted out. */
export const REVIEW_REMINDER_CUTOFF_DAYS = 10;

export interface DigestSweepResult {
  scanned: number;
  sent: number;
  skippedNoCalls: number;
  failed: number;
}

interface DigestSubscription {
  id: string;
  clientId: string;
  digestHour: number;
  timezone: string;
  ownerWhatsapp: string | null;
  metaConnection: {
    id: string;
    externalId: string;
    status: string;
    accessTokenCiphertext: Buffer;
    accessTokenIv: Buffer;
    accessTokenTag: Buffer;
  } | null;
}

const SUBSCRIPTION_SELECT = {
  id: true,
  clientId: true,
  digestHour: true,
  timezone: true,
  ownerWhatsapp: true,
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
} as const;

/**
 * Send each active client's end-of-day summary.
 *
 * Idempotent by the (subscription, localDate) unique: the row is created
 * BEFORE the send, so a tick that crashes mid-send cannot produce a
 * second digest, and a duplicate create is caught and treated as "someone
 * else already has this one" rather than as a failure.
 *
 * A day with no recoverable calls produces no message at all. An empty
 * "no has perdido ninguna llamada hoy" every evening is how a client
 * learns to ignore the number we need him to read.
 */
export async function sendDailyDigests(
  prisma: PrismaClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<DigestSweepResult> {
  const now = opts.now ?? new Date();
  const result: DigestSweepResult = { scanned: 0, sent: 0, skippedNoCalls: 0, failed: 0 };

  const subscriptions = (await prisma.recallSubscription.findMany({
    where: { status: 'active', ownerWhatsapp: { not: null } },
    take: opts.limit ?? 50,
    select: SUBSCRIPTION_SELECT,
  })) as DigestSubscription[];

  for (const subscription of subscriptions) {
    try {
      if (!isDigestDue(subscription, now)) continue;
      result.scanned += 1;

      const localDate = localDateFor(now, subscription.timezone);
      const existing = await prisma.recallDigest.findUnique({
        where: { subscriptionId_localDate: { subscriptionId: subscription.id, localDate } },
        select: { id: true, sentAt: true, attempts: true, callEventIds: true },
      });
      if (existing?.sentAt) continue;
      if (existing && existing.attempts >= MAX_DIGEST_ATTEMPTS) continue;

      const since = startOfLocalDay(now, subscription.timezone);
      const calls = existing
        ? await hydrateCalls(prisma, callIdsOf(existing.callEventIds))
        : await listDigestCalls(prisma, subscription.id, since, now);

      if (calls.length === 0) {
        result.skippedNoCalls += 1;
        continue;
      }

      const digestId = existing?.id ?? (await createDigestRow(prisma, subscription, localDate, calls));
      if (!digestId) continue; // Lost a race; the winner will send it.

      const sender = metaSenderFor(subscription.metaConnection);
      if (!sender || !subscription.ownerWhatsapp) {
        await recordDigestFailure(prisma, digestId, 'meta_connection_unavailable');
        result.failed += 1;
        continue;
      }

      const sent = await sendTemplate(sender.token, sender.phoneNumberId, subscription.ownerWhatsapp, {
        ...DIGEST_TEMPLATES.daily,
        bodyParams: [String(calls.length), buildDigestList(calls)],
      });

      if (!sent.ok) {
        await recordDigestFailure(prisma, digestId, sent.error);
        result.failed += 1;
        continue;
      }

      await prisma.recallDigest.update({
        where: { id: digestId },
        data: { sentAt: now, sendError: null },
      });
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      logError('recall_reviews.digest_failed', err, { subscriptionId: subscription.id }, 'warn');
    }
  }

  return result;
}

/** Re-read the calls a stored digest already committed to, preserving the
 *  ORDER it recorded. The owner's "3" means the third line of the message
 *  he was sent, so re-querying and re-sorting would remap his answer. */
async function hydrateCalls(prisma: PrismaClient, ids: readonly string[]): Promise<DigestCall[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.callEvent.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, fromNumber: true, withheld: true, transcript: true, outcome: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is DigestCall => row !== undefined);
}

async function createDigestRow(
  prisma: PrismaClient,
  subscription: DigestSubscription,
  localDate: string,
  calls: readonly DigestCall[],
): Promise<string | null> {
  try {
    const row = await prisma.recallDigest.create({
      data: {
        clientId: subscription.clientId,
        subscriptionId: subscription.id,
        localDate,
        callEventIds: calls.map((call) => call.id),
      },
      select: { id: true },
    });
    return row.id;
  } catch {
    // The unique fired: another worker created today's digest between our
    // read and our write. Theirs is as good as ours.
    return null;
  }
}

async function recordDigestFailure(prisma: PrismaClient, digestId: string, error: string): Promise<void> {
  await prisma.recallDigest
    .update({
      where: { id: digestId },
      data: { sendError: error.slice(0, 500), attempts: { increment: 1 } },
    })
    .catch(() => null);
}

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

export type DigestReplyOutcome =
  | { status: 'applied'; selected: number; campaignId: string | null }
  | { status: 'none_selected' }
  | { status: 'clarify_sent' }
  | { status: 'ignored'; reason: 'no_open_digest' | 'already_answered' | 'unclear_again' };

/**
 * Find the digest an inbound owner message is answering, if any.
 *
 * Scoped by time as well as by owner: a message three days after the last
 * digest is a man talking to his customers, not answering us. Getting
 * that wrong would mean silently treating ordinary conversation as a
 * review instruction.
 */
export async function findOpenDigest(
  prisma: PrismaClient,
  subscriptionId: string,
  now: Date,
): Promise<{ id: string; callEventIds: unknown; respondedAt: Date | null; clarifiedAt: Date | null } | null> {
  const since = new Date(now.getTime() - DIGEST_REPLY_WINDOW_HOURS * 60 * 60 * 1000);
  return prisma.recallDigest.findFirst({
    where: { subscriptionId, sentAt: { gte: since } },
    orderBy: { sentAt: 'desc' },
    select: { id: true, callEventIds: true, respondedAt: true, clarifiedAt: true },
  });
}

/**
 * Apply what the owner said.
 *
 * The raw text is stored verbatim whatever happens, including when we
 * could not understand it. If he later disputes what he asked for, that
 * string is the answer — and if the parser is wrong about a phrasing, the
 * stored replies are the only way to find out.
 *
 * An unintelligible reply gets ONE clarification and then silence. A
 * second nag for a message he chose to ignore is how a client starts
 * muting the number he is paying us for.
 */
export async function applyDigestReply(
  prisma: PrismaClient,
  input: { subscriptionId: string; text: string },
  opts: { now?: Date } = {},
): Promise<DigestReplyOutcome> {
  const now = opts.now ?? new Date();

  const digest = await findOpenDigest(prisma, input.subscriptionId, now);
  if (!digest) return { status: 'ignored', reason: 'no_open_digest' };
  if (digest.respondedAt) return { status: 'ignored', reason: 'already_answered' };

  const callEventIds = callIdsOf(digest.callEventIds);
  const parsed = parseDigestReply(input.text, callEventIds.length);

  if (parsed.kind === 'unclear') {
    if (digest.clarifiedAt) {
      // Asked once already. Record the attempt and stop.
      await prisma.recallDigest
        .update({ where: { id: digest.id }, data: { rawResponse: input.text.slice(0, 1000) } })
        .catch(() => null);
      return { status: 'ignored', reason: 'unclear_again' };
    }
    await sendClarification(prisma, input.subscriptionId, digest.id, callEventIds, now, input.text);
    return { status: 'clarify_sent' };
  }

  const selectedIds = resolveSelection(parsed, callEventIds);

  await prisma.recallDigest.update({
    where: { id: digest.id },
    data: {
      rawResponse: input.text.slice(0, 1000),
      selectedCallEventIds: selectedIds,
      respondedAt: now,
    },
  });

  if (selectedIds.length === 0) return { status: 'none_selected' };

  const campaignId = await requestReviewsFor(prisma, input.subscriptionId, selectedIds);
  if (campaignId) {
    await prisma.recallDigest
      .update({ where: { id: digest.id }, data: { campaignId } })
      .catch(() => null);
  }
  return { status: 'applied', selected: selectedIds.length, campaignId };
}

async function sendClarification(
  prisma: PrismaClient,
  subscriptionId: string,
  digestId: string,
  callEventIds: readonly string[],
  now: Date,
  rawText: string,
): Promise<void> {
  const subscription = (await prisma.recallSubscription.findUnique({
    where: { id: subscriptionId },
    select: SUBSCRIPTION_SELECT,
  })) as DigestSubscription | null;

  const sender = metaSenderFor(subscription?.metaConnection ?? null);
  if (subscription?.ownerWhatsapp && sender) {
    const calls = await hydrateCalls(prisma, callEventIds);
    await sendTemplate(sender.token, sender.phoneNumberId, subscription.ownerWhatsapp, {
      ...DIGEST_TEMPLATES.clarify,
      bodyParams: [buildDigestList(calls)],
    }).catch(() => null);
  }

  // Stamped whether or not the send worked: the point of the stamp is
  // "we have already tried once", and a failed clarification is not a
  // reason to try a second time tomorrow.
  await prisma.recallDigest
    .update({
      where: { id: digestId },
      data: { clarifiedAt: now, rawResponse: rawText.slice(0, 1000) },
    })
    .catch(() => null);
}

/**
 * Turn the owner's selection into review invitations.
 *
 * Returns null when the client has no Google Business connection: the
 * reply is still recorded, because what he asked for is worth keeping
 * even when we cannot act on it yet, and an operator connecting Google
 * later is a normal part of onboarding.
 */
async function requestReviewsFor(
  prisma: PrismaClient,
  subscriptionId: string,
  callEventIds: readonly string[],
): Promise<string | null> {
  const subscription = await prisma.recallSubscription.findUnique({
    where: { id: subscriptionId },
    select: {
      id: true,
      clientId: true,
      googleConnectionId: true,
      googleConnection: true,
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
      client: { select: { name: true, companyName: true } },
    },
  });
  if (!subscription?.googleConnection) return null;

  const calls = await prisma.callEvent.findMany({
    where: { id: { in: [...callEventIds] }, fromNumber: { not: null }, withheld: false },
    select: { fromNumber: true },
  });
  const recipients = calls
    .map((call) => call.fromNumber)
    .filter((number): number is string => number !== null)
    .map((number) => ({ recipient: number, name: null }));
  if (recipients.length === 0) return null;

  const sender = metaSenderFor(subscription.metaConnection);
  const whatsapp: WhatsAppSenderCredentials | undefined = sender
    ? { token: sender.token, phoneNumberId: sender.phoneNumberId }
    : undefined;

  const businessName = subscription.client.companyName ?? subscription.client.name;
  const result = await createCampaignWithRequests({
    connection: subscription.googleConnection,
    businessName,
    // Dated rather than named after the client: an operator scanning the
    // campaign list needs to know WHICH day's work each one came from.
    campaignName: `Recall ${new Date().toISOString().slice(0, 10)}`,
    consentBasis: 'customer_relationship',
    recipients,
    channel: 'whatsapp',
    whatsapp,
  });

  return result.ok ? result.campaignId : null;
}

// ---------------------------------------------------------------------------
// The single reminder
// ---------------------------------------------------------------------------

export interface ReminderSweepResult {
  scanned: number;
  reminded: number;
  failed: number;
}

/**
 * One nudge, four days later, to anyone who never opened their link.
 *
 * "Never opened" rather than "never reviewed" on purpose: whether someone
 * actually left a review, and what they said, is none of our business and
 * is not recorded anywhere. clickedAt is all we have and all we want.
 *
 * remindedAt makes a second reminder structurally impossible — there is
 * nowhere to record one, so no future code path can send it without a
 * migration to justify itself first.
 */
export async function sweepReviewReminders(
  prisma: PrismaClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<ReminderSweepResult> {
  const now = opts.now ?? new Date();
  const dueBefore = new Date(now.getTime() - REVIEW_REMINDER_DAYS * 24 * 60 * 60 * 1000);
  const tooOld = new Date(now.getTime() - REVIEW_REMINDER_CUTOFF_DAYS * 24 * 60 * 60 * 1000);

  const pending = await prisma.reviewRequest.findMany({
    where: {
      status: 'sent',
      channel: 'whatsapp',
      clickedAt: null,
      remindedAt: null,
      sentAt: { lte: dueBefore, gte: tooOld },
    },
    orderBy: { sentAt: 'asc' },
    take: opts.limit ?? 50,
    select: {
      id: true,
      recipient: true,
      recipientName: true,
      campaign: {
        select: {
          clientId: true,
          client: { select: { name: true, companyName: true } },
        },
      },
    },
  });

  const result: ReminderSweepResult = { scanned: pending.length, reminded: 0, failed: 0 };
  // One sender lookup per client, not per request: a campaign of thirty
  // would otherwise decrypt the same token thirty times.
  const senders = new Map<string, MetaSender | null>();

  for (const request of pending) {
    try {
      const clientId = request.campaign.clientId;
      if (!senders.has(clientId)) senders.set(clientId, await senderForClient(prisma, clientId));
      const sender = senders.get(clientId) ?? null;
      if (!sender) continue;

      const businessName = request.campaign.client.companyName ?? request.campaign.client.name;
      const sent = await dispatchReviewRequest(
        'whatsapp',
        {
          to: request.recipient,
          recipientName: request.recipientName,
          businessName,
          trackingUrl: request.id,
          trackingSuffix: request.id,
        },
        sender,
      );

      if (!sent.ok) {
        result.failed += 1;
        continue;
      }
      // Stamped only after a successful send, so a provider outage delays
      // the reminder rather than consuming it.
      await prisma.reviewRequest.update({ where: { id: request.id }, data: { remindedAt: now } });
      result.reminded += 1;
    } catch (err) {
      result.failed += 1;
      logError('recall_reviews.reminder_failed', err, { requestId: request.id }, 'warn');
    }
  }

  return result;
}

async function senderForClient(prisma: PrismaClient, clientId: string): Promise<MetaSender | null> {
  const connection = await prisma.metaChannelConnection.findFirst({
    where: { clientId, channel: 'whatsapp', status: 'active' },
    select: {
      id: true,
      externalId: true,
      status: true,
      accessTokenCiphertext: true,
      accessTokenIv: true,
      accessTokenTag: true,
    },
  });
  return metaSenderFor(connection);
}
