import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { runProspectingSearch, isProspectingRunDue } from '@/lib/prospecting';
import { sweepPendingEnrichment } from '@/lib/prospecting-enrichment';
import { runProspectingContact } from '@/lib/prospecting-contact';
import { sendProspectingBatchEmail } from '@/lib/leads-email';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/prospecting-tick
 *
 * The single endpoint the `scheduler` container calls for Prospección
 * con IA — same "one endpoint, the caller is dumb, TypeScript decides
 * what's due" design as recall-tick. Each active campaign re-checks its
 * own due-ness (isProspectingRunDue), so a coarse or missed tick delays
 * a campaign's next run rather than skipping it outright.
 *
 * Same auth as every other /api/cron/* route:
 * `Authorization: Bearer <CRON_SECRET>`, failing closed when unset.
 *
 * Campaigns run sequentially and each is isolated: one campaign's
 * failure (a bad Google response, a DB hiccup) reports its own error
 * and every other campaign this tick still runs. A 200 with a `failed`
 * entry is the normal way a campaign reports trouble — telemetry the
 * scheduler logs, not a control signal.
 *
 * Fase B — after the per-campaign search loop, one more isolated step:
 * sweepPendingEnrichment (src/lib/prospecting-enrichment.ts) crawls up to
 * ENRICHMENT_BATCH_SIZE outbound leads' websites and hands them to n8n.
 * This runs once per tick, not once per campaign — it's a flat sweep
 * across leads, same shape as recall-tick's own non-campaign jobs.
 *
 * Fase C — runProspectingContact runs per CONSENTED campaign (not
 * per-due, unlike the search loop above): whether there's a lead to
 * message is driven by what Fase A/B already found, not by the weekly
 * search cadence, so a campaign with consent is checked every tick. Its
 * own daily cap and quality-rating gate are what actually bound the
 * work — see prospecting-contact.ts.
 */
function isAuthorizedCronRequest(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

type CampaignOutcome =
  | { ok: true; created: number; capReached: boolean }
  | { ok: false; error: string };

export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isDatabaseConfigured) {
    return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const now = new Date();

  const campaigns = await prisma.prospectingCampaign.findMany({
    where: { status: 'active', category: { not: null }, locationQuery: { not: null } },
    select: {
      id: true,
      clientId: true,
      tenantId: true,
      category: true,
      locationQuery: true,
      leadsFoundThisMonth: true,
      monthlyLeadCap: true,
      usageResetAt: true,
      alertedAt: true,
      lastRunAt: true,
      status: true,
      consentAcknowledgedAt: true,
      consentVersion: true,
      autoContactPausedAt: true,
    },
  });

  const due = campaigns.filter((c) => isProspectingRunDue(c.lastRunAt, now));

  const results: Record<string, CampaignOutcome> = {};

  for (const campaign of due) {
    try {
      const result = await runProspectingSearch(prisma, campaign, now);
      if (!result.ok) {
        results[campaign.id] = { ok: false, error: result.error };
        continue;
      }
      results[campaign.id] = { ok: true, created: result.created, capReached: result.capReached };

      // Best-effort, same posture as leads/route.ts's new-lead
      // notification — the campaign run already succeeded and its
      // Leads are already persisted regardless of whether this email
      // sends.
      if (result.created > 0) {
        try {
          const client = await prisma.chatbotClient.findUnique({
            where: { id: campaign.clientId },
            select: { email: true, name: true, companyName: true },
          });
          if (client) {
            const emailResult = await sendProspectingBatchEmail({
              to: client.email,
              businessName: client.companyName ?? client.name,
              count: result.created,
            });
            if (!emailResult.ok) {
              logError(
                'prospecting_tick.batch_email_failed',
                new Error(emailResult.error),
                { campaignId: campaign.id },
                'warn',
              );
            }
          }
        } catch (err) {
          logError('prospecting_tick.batch_email_notification_failed', err, { campaignId: campaign.id }, 'warn');
        }
      }
    } catch (err) {
      logError('prospecting_tick.campaign_failed', err, { campaignId: campaign.id }, 'warn');
      results[campaign.id] = { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  let enrichment: { ok: true; processed: number; delivered: number; crawlFailed: number } | { ok: false; error: string };
  try {
    const result = await sweepPendingEnrichment(prisma, now);
    enrichment = { ok: true, ...result };
  } catch (err) {
    logError('prospecting_tick.enrichment_failed', err, {}, 'warn');
    enrichment = { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }

  type ContactOutcome =
    | { ok: true; sent: number; failed: number; capReached: boolean }
    | { ok: false; error: string };
  const contact: Record<string, ContactOutcome> = {};
  const consented = campaigns.filter((c) => c.consentAcknowledgedAt !== null);
  for (const campaign of consented) {
    try {
      contact[campaign.id] = await runProspectingContact(prisma, campaign, now);
    } catch (err) {
      logError('prospecting_tick.contact_failed', err, { campaignId: campaign.id }, 'warn');
      contact[campaign.id] = { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  return NextResponse.json({ ok: true, dueCount: due.length, results, enrichment, contact });
}
