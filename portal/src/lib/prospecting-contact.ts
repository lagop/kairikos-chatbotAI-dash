import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { sendTemplate, getPhoneNumberInfo } from './whatsapp-api';
import { metaSenderFor } from './recall-messaging';
import { logError } from './observability';

// =============================================================================
// Prospección con IA, Fase C — the highest-risk piece of this product:
// messaging a prospect who never asked to hear from the client, from the
// client's OWN WhatsApp number. See the session's plan for why this is
// gated behind explicit consent and stays the last phase, not the first.
//
// Nothing sends unless the client has explicitly opted in
// (ProspectingCampaign.consentAcknowledgedAt/consentVersion, set via
// PATCH /api/portal/prospecting/campaign/consent) — there is no default-on
// path anywhere in this module.
//
// The quality-rating gate below reads MetaChannelConnection.qualityRating
// LIVE from Meta on every run rather than trusting the stored mirror
// (that column is currently only ever written at connect time — see
// recall-meta.ts — so trusting it here could mean gating on a
// months-stale value for exactly the check that matters most). A
// check that fails outright fails CLOSED: skip sending, never send blind.
// =============================================================================

/** Bumping this string is how a future change to the consent copy in
 *  ProspectingProfileCard.tsx invalidates old consent automatically —
 *  the send gate below compares this against the stored consentVersion,
 *  not just checking consentAcknowledgedAt is non-null. */
export const PROSPECTING_CONSENT_VERSION = 'v1';

/**
 * The template Meta has to approve for this product. Same contract as
 * RECALL_TEMPLATES in recall-messaging.ts: name/language/param count is
 * what was submitted to Meta — changing any of it means resubmitting.
 * {{1}} the prospect's own name (from Place Details), {{2}} the client's
 * business name (who is reaching out).
 */
export const PROSPECTING_TEMPLATES = {
  firstContact: { name: 'prospecting_first_contact', languageCode: 'es' },
} as const;

/** Hard, product-wide ceiling — not tier-scaled, deliberately. This is a
 *  number-reputation safety brake, not a revenue lever: a burst of cold
 *  messages in one day is exactly the pattern that gets a number reported
 *  and its quality rating tanked, which is the one failure mode this
 *  entire phase exists to avoid triggering. */
export const MAX_AUTO_CONTACTS_PER_DAY = 20;

/** Give up on a permanently-failing number after this many attempts —
 *  same value and reasoning as recall-messaging.ts's MAX_NOTIFY_ATTEMPTS:
 *  without a bound a bad number would be retried every tick forever. */
export const MAX_AUTO_CONTACT_ATTEMPTS = 3;

/** UTC calendar day, not per-client local time — same reasoning as
 *  prospecting.ts's isNewCalendarMonth: this is a safety quota, not a
 *  client-facing report boundary. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface ProspectingContactCampaignInput {
  id: string;
  clientId: string;
  tenantId: string | null;
  status: string;
  consentAcknowledgedAt: Date | null;
  consentVersion: string | null;
  autoContactPausedAt: Date | null;
}

export type RunProspectingContactResult =
  | { ok: true; sent: number; failed: number; capReached: boolean }
  | {
      ok: false;
      error:
        | 'campaign_paused'
        | 'no_consent'
        | 'auto_paused'
        | 'no_whatsapp_connection'
        | 'quality_check_failed'
        | 'quality_degraded';
    };

/**
 * One run of one campaign's auto-contact step. Safe to call every tick —
 * the daily cap and per-lead attempt cap are re-derived from the DB each
 * time, never trusted from a timer, same posture as every other job in
 * this product.
 */
export async function runProspectingContact(
  prisma: PrismaClient,
  campaign: ProspectingContactCampaignInput,
  now: Date = new Date(),
): Promise<RunProspectingContactResult> {
  if (campaign.status !== 'active') {
    return { ok: false, error: 'campaign_paused' };
  }
  if (!campaign.consentAcknowledgedAt || campaign.consentVersion !== PROSPECTING_CONSENT_VERSION) {
    return { ok: false, error: 'no_consent' };
  }
  if (campaign.autoContactPausedAt) {
    return { ok: false, error: 'auto_paused' };
  }

  const connection = await prisma.metaChannelConnection.findFirst({
    where: { clientId: campaign.clientId, channel: 'whatsapp', status: 'active' },
    select: {
      id: true,
      externalId: true,
      status: true,
      accessTokenCiphertext: true,
      accessTokenIv: true,
      accessTokenTag: true,
    },
  });
  const sender = metaSenderFor(connection);
  if (!sender) {
    return { ok: false, error: 'no_whatsapp_connection' };
  }

  const info = await getPhoneNumberInfo(sender.token, sender.phoneNumberId);
  if (!info.ok) {
    logError('prospecting_contact.quality_check_failed', new Error(info.error), { campaignId: campaign.id }, 'warn');
    return { ok: false, error: 'quality_check_failed' };
  }

  // Keep the stored mirror fresh as a side effect for other surfaces
  // (the operator panel reads MetaChannelConnection.qualityRating) — the
  // gate below always uses the freshly-fetched value above, never this.
  if (connection) {
    await prisma.metaChannelConnection
      .update({ where: { id: connection.id }, data: { qualityRating: info.data.quality_rating ?? null } })
      .catch(() => null);
  }

  if (info.data.quality_rating === 'YELLOW' || info.data.quality_rating === 'RED') {
    await prisma.prospectingCampaign.update({ where: { id: campaign.id }, data: { autoContactPausedAt: now } });
    logError(
      'prospecting_contact.quality_degraded',
      new Error(`quality_rating=${info.data.quality_rating}`),
      { campaignId: campaign.id },
      'warn',
    );
    return { ok: false, error: 'quality_degraded' };
  }

  const sentToday = await prisma.leadAudit.count({
    where: { clientId: campaign.clientId, action: 'contacted_auto', changedAt: { gte: startOfUtcDay(now) } },
  });
  const remaining = MAX_AUTO_CONTACTS_PER_DAY - sentToday;
  if (remaining <= 0) {
    return { ok: true, sent: 0, failed: 0, capReached: true };
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: campaign.clientId },
    select: { name: true, companyName: true },
  });
  const businessName = client?.companyName ?? client?.name ?? '';

  const candidates = await prisma.lead.findMany({
    where: {
      clientId: campaign.clientId,
      source: 'outbound',
      status: 'nuevo',
      contactPhone: { not: null },
      autoContactAttempts: { lt: MAX_AUTO_CONTACT_ATTEMPTS },
    },
    orderBy: { createdAt: 'asc' },
    take: remaining,
  });

  let sent = 0;
  let failed = 0;

  for (const lead of candidates) {
    const phone = lead.contactPhone;
    if (!phone) continue;

    const result = await sendTemplate(sender.token, sender.phoneNumberId, phone, {
      ...PROSPECTING_TEMPLATES.firstContact,
      bodyParams: [lead.contactName ?? 'equipo', businessName],
    });

    if (result.ok) {
      await prisma.$transaction(async (tx) => {
        await tx.lead.update({
          where: { id: lead.id },
          data: { status: 'contactado', contactedAt: now, autoContactError: null },
        });
        await tx.leadAudit.create({
          data: {
            leadId: lead.id,
            clientId: campaign.clientId,
            tenantId: campaign.tenantId,
            action: 'contacted_auto',
            statusBefore: 'nuevo',
            statusAfter: 'contactado',
            actorId: 'system:prospecting',
          },
        });
      });
      sent += 1;
    } else {
      const attempts = lead.autoContactAttempts + 1;
      await prisma.lead.update({
        where: { id: lead.id },
        data: { autoContactAttempts: attempts, autoContactError: result.error.slice(0, 500) },
      });
      logError('prospecting_contact.send_failed', new Error(result.error), { leadId: lead.id, campaignId: campaign.id }, 'warn');
      failed += 1;
    }
  }

  return { ok: true, sent, failed, capReached: sentToday + sent >= MAX_AUTO_CONTACTS_PER_DAY };
}
