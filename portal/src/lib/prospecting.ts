import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { isGooglePlacesConfigured, searchPlaces, getPlaceDetails } from './google-places';
import { logError } from './observability';

// =============================================================================
// Prospección con IA, Fase A — runProspectingSearch is the whole engine:
// one campaign run turns a client's target profile (category + zone)
// into new Lead rows, respecting a monthly cost cap. No contact happens
// here or anywhere in Fase A — see the plan.
//
// The billing invariant this module exists to protect: leadsFoundThisMonth
// must stay 1:1 with real Google Places Details calls made (the ones that
// actually cost money — see google-places.ts's getPlaceDetails comment),
// NOT with Lead rows created. A closed business still burns a Details
// call even though no Lead comes out of it, so it still counts against
// the cap — undercounting it would let a campaign quietly cost more than
// its tier's price was set to cover.
// =============================================================================

export interface ProspectingCampaignInput {
  id: string;
  clientId: string;
  tenantId: string | null;
  category: string | null;
  locationQuery: string | null;
  leadsFoundThisMonth: number;
  monthlyLeadCap: number;
  usageResetAt: Date;
  alertedAt: Date | null;
}

export type RunProspectingSearchResult =
  | {
      ok: true;
      created: number;
      skippedDuplicate: number;
      skippedClosed: number;
      detailsCallsMade: number;
      capReached: boolean;
    }
  | { ok: false; error: 'not_configured' | 'campaign_not_ready' | 'search_failed' };

/** UTC calendar month, not per-client local time — this is a cost quota,
 *  not a client-facing report boundary, so it doesn't need
 *  recall-reports.ts's timezone precision. */
function isNewCalendarMonth(usageResetAt: Date, now: Date): boolean {
  return usageResetAt.getUTCFullYear() !== now.getUTCFullYear() || usageResetAt.getUTCMonth() !== now.getUTCMonth();
}

/**
 * One run of one campaign. Safe to call more often than the campaign
 * actually needs (same posture as every job in recall-tick) — a
 * duplicate-heavy run just does less new work, it never double-charges
 * or double-creates, because every candidate is checked against
 * Lead.externalPlaceId before a single Details call is spent on it.
 */
export async function runProspectingSearch(
  prisma: PrismaClient,
  campaign: ProspectingCampaignInput,
  now: Date = new Date(),
): Promise<RunProspectingSearchResult> {
  if (!isGooglePlacesConfigured()) {
    return { ok: false, error: 'not_configured' };
  }
  if (!campaign.category || !campaign.locationQuery) {
    // The client hasn't filled in their target profile yet — nothing to
    // search for. Not an error, just nothing to do this tick.
    return { ok: false, error: 'campaign_not_ready' };
  }

  let leadsFoundThisMonth = campaign.leadsFoundThisMonth;
  let usageResetAt = campaign.usageResetAt;
  let alertedAt = campaign.alertedAt;
  if (isNewCalendarMonth(usageResetAt, now)) {
    leadsFoundThisMonth = 0;
    usageResetAt = now;
    alertedAt = null;
  }

  const remaining = campaign.monthlyLeadCap - leadsFoundThisMonth;
  if (remaining <= 0) {
    // Warn once per cap breach (alertedAt), same pattern as
    // RecallUsageMonth.alertedAt in recall-reports.ts's rollUpUsage —
    // never spam every tick after the cap is hit.
    if (!alertedAt) {
      await prisma.prospectingCampaign.update({
        where: { id: campaign.id },
        data: { alertedAt: now, leadsFoundThisMonth, usageResetAt },
      });
    }
    return { ok: true, created: 0, skippedDuplicate: 0, skippedClosed: 0, detailsCallsMade: 0, capReached: true };
  }

  const textQuery = `${campaign.category} en ${campaign.locationQuery}`;
  const searchResult = await searchPlaces({ textQuery });
  if (!searchResult.ok) {
    logError('prospecting.search_failed', new Error(searchResult.error), { campaignId: campaign.id }, 'warn');
    return { ok: false, error: 'search_failed' };
  }

  const candidateIds = searchResult.data.results.map((r) => r.id);
  const existing =
    candidateIds.length > 0
      ? await prisma.lead.findMany({
          where: { clientId: campaign.clientId, externalPlaceId: { in: candidateIds } },
          select: { externalPlaceId: true },
        })
      : [];
  const existingIds = new Set(existing.map((r) => r.externalPlaceId));

  const newResults = searchResult.data.results.filter((r) => !existingIds.has(r.id));
  // Never spend more Details calls than the remaining monthly budget,
  // even if the search turned up more new businesses than that.
  const toProcess = newResults.slice(0, remaining);

  let created = 0;
  let skippedClosed = 0;
  let detailsCallsMade = 0;

  for (const candidate of toProcess) {
    const details = await getPlaceDetails(candidate.id);
    if (!details.ok) {
      // A failed call is neither billed success nor a lead — doesn't
      // count against detailsCallsMade, doesn't create a row. Logged so
      // a pattern of failures (bad key, quota exhausted) is visible.
      logError(
        'prospecting.details_failed',
        new Error(details.error),
        { campaignId: campaign.id, placeId: candidate.id },
        'warn',
      );
      continue;
    }
    detailsCallsMade += 1;

    if (details.data.businessStatus === 'CLOSED_PERMANENTLY') {
      // Still billed (the call was made), but not a real prospect — no
      // Lead for a business that no longer exists.
      skippedClosed += 1;
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        const lead = await tx.lead.create({
          data: {
            clientId: campaign.clientId,
            tenantId: campaign.tenantId,
            source: 'outbound',
            channel: 'places',
            status: 'nuevo',
            externalPlaceId: candidate.id,
            contactName: details.data.name,
            contactPhone: details.data.phoneNumber,
            summary: details.data.formattedAddress
              ? `Negocio encontrado en ${details.data.formattedAddress}.`
              : null,
          },
        });
        await tx.leadAudit.create({
          data: {
            leadId: lead.id,
            clientId: campaign.clientId,
            tenantId: campaign.tenantId,
            action: 'created',
            statusBefore: null,
            statusAfter: 'nuevo',
            actorId: 'system:prospecting',
          },
        });
      });
      created += 1;
    } catch (err) {
      // Lead.@@unique([clientId, externalPlaceId]) is the backstop
      // against a race with another concurrent run of the same
      // campaign — the pre-check above makes this rare, not impossible.
      // The Details call was still billed either way, so
      // detailsCallsMade above already accounts for the cost; only the
      // Lead itself failed to persist.
      logError('prospecting.lead_persist_failed', err, { campaignId: campaign.id, placeId: candidate.id }, 'warn');
    }
  }

  const newLeadsFoundThisMonth = leadsFoundThisMonth + detailsCallsMade;
  const capReached = newLeadsFoundThisMonth >= campaign.monthlyLeadCap;
  await prisma.prospectingCampaign.update({
    where: { id: campaign.id },
    data: {
      leadsFoundThisMonth: newLeadsFoundThisMonth,
      usageResetAt,
      lastRunAt: now,
      // Newly reached this run → stamp it. Already past it from a prior
      // run → alertedAt is already set from that run's own update, so
      // this branch never re-fires; not reached → clear it (a campaign
      // whose cap was raised, or that rolled into a new month, gets
      // warned again next time it genuinely hits the new cap).
      alertedAt: capReached ? (alertedAt ?? now) : null,
    },
  });

  return {
    ok: true,
    created,
    skippedDuplicate: newResults.length - toProcess.length,
    skippedClosed,
    detailsCallsMade,
    capReached,
  };
}
