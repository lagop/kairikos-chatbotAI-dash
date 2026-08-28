import 'server-only';
import type { PrismaClient, Prisma } from '@prisma/client';
import { deliverChannelEvent } from './channel-webhook';
import { getContentGenerationMinIntervalDays } from './seo-settings';
import { logError } from './observability';

// =============================================================================
// SEO con IA, Fase C — content generation. For each client with an
// active 'seo' contract and enough onboarding context, the portal
// gathers its own signals (latest site audit + recent Search Console
// totals — no live API calls here, both are already synced by Fase A/B)
// and hands them to n8n, which drafts ONE article with its own LLM and
// calls back PATCH /api/internal/seo/content-drafts/[id] — same
// portal/n8n boundary as prospecting-enrichment.ts: gathering signals is
// I/O + already-stored data, writing an article is interpretation, and
// interpretation is n8n's job, never done inline in the portal.
//
// A SeoContentDraft row is created with status 'pending_generation' the
// moment generation is REQUESTED, before n8n has replied — same
// "request-time row, not response-time row" shape as this repo already
// uses (deliverChannelEvent's own ChannelWebhookDelivery row). This is
// what lets an operator see "solicitado, todavía sin volver" as a real
// state, and is also the same row the callback route PATCHes.
//
// v1 requests exactly one draft per due profile per cadence — scaling
// toward the marketing copy's "8-12 artículos/mes" is the operator
// lowering minIntervalDays via /admin/portal/settings/seo (see
// lib/seo-settings.ts), not a different mechanism. A client's own
// SeoProfile.contentGenerationMinIntervalDaysOverride, when set, wins
// over that global value for that one client (see the field's own
// schema comment) — set from the operator's technical-setup panel.
// =============================================================================

/** Same one-place-enforces-the-cadence reasoning as every other
 *  isSyncDue/isDigestDue in this codebase. minIntervalDays is passed in
 *  (not read from settings internally) so this stays a pure, easily
 *  tested function — sweepDueProfiles resolves the operator-configured
 *  value once per sweep via getContentGenerationMinIntervalDays. */
export function isGenerationDue(lastContentRequestedAt: Date | null, minIntervalDays: number): boolean {
  if (!lastContentRequestedAt) return true;
  return Date.now() - lastContentRequestedAt.getTime() >= minIntervalDays * 24 * 60 * 60_000;
}

interface ProfileForGeneration {
  id: string;
  clientId: string;
  tenantId: string | null;
  businessDescription: string | null;
  targetAudience: string | null;
  toneOfVoice: string | null;
  siteUrl: string | null;
  lastAuditResult: unknown;
  lastContentRequestedAt: Date | null;
  contentGenerationMinIntervalDaysOverride: number | null;
}

async function buildSourceSignals(prisma: PrismaClient, profile: ProfileForGeneration): Promise<Record<string, unknown>> {
  const connection = await prisma.googleSeoConnection.findUnique({
    where: { clientId: profile.clientId },
    select: { id: true, status: true },
  });

  let searchConsoleSummary: { totalClicks: number; totalImpressions: number; days: number } | null = null;
  if (connection?.status === 'active') {
    const metrics = await prisma.seoSearchConsoleMetric.findMany({
      where: { connectionId: connection.id },
      select: { clicks: true, impressions: true },
    });
    if (metrics.length > 0) {
      searchConsoleSummary = {
        totalClicks: metrics.reduce((sum, m) => sum + m.clicks, 0),
        totalImpressions: metrics.reduce((sum, m) => sum + m.impressions, 0),
        days: metrics.length,
      };
    }
  }

  return {
    businessDescription: profile.businessDescription,
    targetAudience: profile.targetAudience,
    toneOfVoice: profile.toneOfVoice,
    siteUrl: profile.siteUrl,
    siteAudit: profile.lastAuditResult ?? null,
    searchConsoleSummary,
  };
}

export interface GenerationSweepResult {
  processed: number;
  requested: number;
  deliveryFailed: number;
}

/**
 * The cron entry point (/api/cron/generate-seo-content). Picks up every
 * SeoProfile whose client still has 'seo' active and whose cadence is
 * due, creates a 'pending_generation' SeoContentDraft, and hands it to
 * n8n via deliverChannelEvent under connectionType 'seo_content'. A
 * failed delivery is NOT retried here — same reasoning as
 * prospecting-enrichment.ts: it's already recorded in
 * ChannelWebhookDelivery for the existing sync-channel-webhooks backoff
 * sweep to retry with the same payload, no second retry machine needed.
 * lastContentRequestedAt is stamped regardless of delivery outcome — a
 * delivery failure gets retried by that sweep with the SAME draft row,
 * not by asking this sweep to try again next tick with a duplicate row.
 */
export async function sweepDueProfiles(prisma: PrismaClient, now: Date = new Date()): Promise<GenerationSweepResult> {
  const globalMinIntervalDays = await getContentGenerationMinIntervalDays();

  const candidates = (await prisma.seoProfile.findMany({
    where: {
      businessDescription: { not: null },
      clientProduct: { status: 'active' },
    },
    select: {
      id: true,
      clientId: true,
      tenantId: true,
      businessDescription: true,
      targetAudience: true,
      toneOfVoice: true,
      siteUrl: true,
      lastAuditResult: true,
      lastContentRequestedAt: true,
      contentGenerationMinIntervalDaysOverride: true,
    },
  })) as ProfileForGeneration[];

  // A per-client override (set on the operator's technical-setup panel)
  // wins over the global default — NULL is "no override, use global",
  // not "zero days"/"always due".
  const due = candidates.filter((p) =>
    isGenerationDue(p.lastContentRequestedAt, p.contentGenerationMinIntervalDaysOverride ?? globalMinIntervalDays),
  );

  let requested = 0;
  let deliveryFailed = 0;

  for (const profile of due) {
    const sourceSignals = await buildSourceSignals(prisma, profile);

    const draft = await prisma.seoContentDraft.create({
      data: {
        profileId: profile.id,
        clientId: profile.clientId,
        tenantId: profile.tenantId,
        status: 'pending_generation',
        sourceSignals: sourceSignals as unknown as Prisma.InputJsonValue,
      },
    });

    const result = await deliverChannelEvent({
      connectionType: 'seo_content',
      connectionId: draft.id,
      clientId: profile.clientId,
      payload: { draftId: draft.id, profileId: profile.id, ...sourceSignals },
    });

    if (result.ok) {
      requested += 1;
    } else {
      deliveryFailed += 1;
      logError('seo_content_generation.delivery_failed', new Error(result.error ?? 'unknown'), {
        draftId: draft.id,
        profileId: profile.id,
      }, 'warn');
    }

    await prisma.seoProfile.update({ where: { id: profile.id }, data: { lastContentRequestedAt: now } });
  }

  return { processed: due.length, requested, deliveryFailed };
}
