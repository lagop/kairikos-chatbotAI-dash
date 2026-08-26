import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { runProspectingSearch, isProspectingRunDue } from '@/lib/prospecting';
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

  return NextResponse.json({ ok: true, dueCount: due.length, results });
}
