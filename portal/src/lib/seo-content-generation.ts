import 'server-only';
import type { PrismaClient, Prisma } from '@prisma/client';
import { getContentGenerationMinIntervalDays } from './seo-settings';
import { generateArticleDraft, type QueryOpportunity } from './seo-content-ai';
import { logError } from './observability';

// =============================================================================
// SEO con IA, Fase C — content generation. For each client with an
// active 'seo' contract and enough onboarding context, the portal
// gathers its own signals (latest site audit + recent Search Console
// totals — no live API calls here, both are already synced by Fase A/B)
// and escribe UN artículo con ellas.
//
// Fase 1.3 — hasta aquí, esto empujaba un evento `seo_content` a n8n y
// esperaba un callback a PATCH /api/internal/seo/content-drafts/[id] con
// el artículo escrito. Ese workflow no existía en ninguna parte: el
// producto medía y publicaba, pero no redactaba. Ahora la redacción vive
// en el portal (lib/seo-content-ai.ts), como ya ocurría con las
// respuestas de reseñas y la clasificación de leads. La ruta del callback
// se mantiene intacta por si vuelve a haber una fuente externa; solo deja
// de ser el camino principal.
//
// Signals also include queryOpportunities — real queries the site
// already shows up for at position 4-20 (page-1-bottom to page-2), the
// "near-miss" content-opportunity signal SeoSearchConsoleQuery exists
// for (see that model's own schema comment). Sorted by impressions so
// n8n's prompt sees the highest-reach opportunities first.
//
// La fila de SeoContentDraft ahora se crea ya en estado 'drafted', con el
// artículo dentro: con la generación en el portal es síncrona, así que el
// estado intermedio 'pending_generation' (que existía para representar
// "solicitado a n8n, todavía sin volver") deja de tener sentido aquí. El
// estado sigue existiendo en el modelo por las filas antiguas y por la
// ruta del callback.
//
// Si la generación falla, NO se crea el borrador ni se marca la cadencia:
// así el siguiente barrido lo reintenta en vez de dejar al cliente sin
// artículo ese mes por un error transitorio del modelo.
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
  /** Fase 2 multi-instancia — de QUÉ contratación es este perfil. Las señales
   *  de Search Console se buscan por aquí, no por cliente: un cliente con dos
   *  webs tiene dos conexiones y mezclarlas escribiría el artículo de una web
   *  con los datos de la otra. */
  clientProductId: string;
  tenantId: string | null;
  /** Resuelto desde ChatbotClient: el artículo lo firma el negocio, así
   *  que el redactor necesita saber cómo se llama. */
  businessName: string;
  businessDescription: string | null;
  targetAudience: string | null;
  toneOfVoice: string | null;
  siteUrl: string | null;
  lastAuditResult: unknown;
  lastContentRequestedAt: Date | null;
  contentGenerationMinIntervalDaysOverride: number | null;
}

// Page-1-bottom to page-2: ranking well enough that Google already
// considers the page relevant, but not well enough to reliably get
// clicked — exactly the band a new or improved article can move.
// Positions 1-3 are already-won queries (nothing to generate for);
// positions past 20 are usually too far from ranking for one article
// to fix.
const OPPORTUNITY_MIN_POSITION = 4;
const OPPORTUNITY_MAX_POSITION = 20;
const MAX_OPPORTUNITIES_IN_SIGNAL = 15;

async function buildSourceSignals(prisma: PrismaClient, profile: ProfileForGeneration): Promise<Record<string, unknown>> {
  const connection = await prisma.googleSeoConnection.findUnique({
    where: { clientProductId: profile.clientProductId },
    select: { id: true, status: true },
  });

  let searchConsoleSummary: { totalClicks: number; totalImpressions: number; days: number } | null = null;
  let queryOpportunities: { query: string; impressions: number; clicks: number; position: number }[] = [];
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

    const opportunities = await prisma.seoSearchConsoleQuery.findMany({
      where: { connectionId: connection.id, position: { gte: OPPORTUNITY_MIN_POSITION, lte: OPPORTUNITY_MAX_POSITION } },
      orderBy: { impressions: 'desc' },
      take: MAX_OPPORTUNITIES_IN_SIGNAL,
      select: { query: true, impressions: true, clicks: true, position: true },
    });
    queryOpportunities = opportunities.map((o) => ({
      query: o.query,
      impressions: o.impressions,
      clicks: o.clicks,
      position: Math.round(o.position * 10) / 10,
    }));
  }

  return {
    businessDescription: profile.businessDescription,
    targetAudience: profile.targetAudience,
    toneOfVoice: profile.toneOfVoice,
    siteUrl: profile.siteUrl,
    siteAudit: profile.lastAuditResult ?? null,
    searchConsoleSummary,
    queryOpportunities,
  };
}

export interface GenerationSweepResult {
  /** Perfiles cuya cadencia toca en este tick. */
  due: number;
  /** De ésos, los que se han intentado (ver MAX_GENERATIONS_PER_TICK). */
  processed: number;
  generated: number;
  failed: number;
  /** Sin ANTHROPIC_API_KEY configurada. */
  skipped: number;
}

/**
 * Techo de artículos por tick. Escribir uno tarda decenas de segundos y la
 * ruta del cron corre con maxDuration = 60, así que un cliente con muchos
 * perfiles vencidos a la vez agotaría el tiempo y no terminaría ninguno.
 * El barrido corre cada 5 minutos y la cadencia real de cada cliente es
 * mensual, así que repartirlos entre ticks no retrasa nada: los que no
 * entran hoy siguen vencidos y entran en el siguiente.
 */
const MAX_GENERATIONS_PER_TICK = 2;

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

  const rows = await prisma.seoProfile.findMany({
    where: {
      businessDescription: { not: null },
      clientProduct: { status: 'active' },
    },
    select: {
      id: true,
      clientId: true,
      clientProductId: true,
      tenantId: true,
      businessDescription: true,
      targetAudience: true,
      toneOfVoice: true,
      siteUrl: true,
      lastAuditResult: true,
      lastContentRequestedAt: true,
      contentGenerationMinIntervalDaysOverride: true,
      client: { select: { companyName: true, name: true } },
    },
  });

  const candidates: ProfileForGeneration[] = rows.map((row) => {
    const { client, ...profile } = row as typeof row & {
      client?: { companyName: string | null; name: string | null } | null;
    };
    return {
      ...(profile as Omit<ProfileForGeneration, 'businessName'>),
      businessName: client?.companyName ?? client?.name ?? 'el negocio',
    };
  });

  // A per-client override (set on the operator's technical-setup panel)
  // wins over the global default — NULL is "no override, use global",
  // not "zero days"/"always due".
  const due = candidates.filter((p) =>
    isGenerationDue(p.lastContentRequestedAt, p.contentGenerationMinIntervalDaysOverride ?? globalMinIntervalDays),
  );

  const batch = due.slice(0, MAX_GENERATIONS_PER_TICK);
  let generated = 0;
  let failed = 0;
  let skipped = 0;

  for (const profile of batch) {
    const sourceSignals = await buildSourceSignals(prisma, profile);

    const article = await generateArticleDraft({
      businessName: profile.businessName,
      businessDescription: profile.businessDescription,
      targetAudience: profile.targetAudience,
      toneOfVoice: profile.toneOfVoice,
      siteUrl: profile.siteUrl,
      siteAudit: sourceSignals.siteAudit,
      queryOpportunities: sourceSignals.queryOpportunities as QueryOpportunity[],
    });

    // Sin clave configurada no hay nada que cobrar ni que marcar: el
    // siguiente barrido lo intenta otra vez en cuanto haya clave.
    if ('skipped' in article) {
      skipped += 1;
      continue;
    }

    if (!article.ok) {
      failed += 1;
      logError('seo_content_generation.generation_failed', new Error(article.error), {
        profileId: profile.id,
      }, 'warn');
      continue;
    }

    await prisma.seoContentDraft.create({
      data: {
        profileId: profile.id,
        clientId: profile.clientId,
        tenantId: profile.tenantId,
        status: 'drafted',
        title: article.title,
        bodyHtml: article.bodyHtml,
        targetKeyword: article.targetKeyword || null,
        metaDescription: article.metaDescription || null,
        generatedAt: now,
        sourceSignals: sourceSignals as unknown as Prisma.InputJsonValue,
      },
    });

    // La cadencia solo avanza cuando hay artículo de verdad.
    await prisma.seoProfile.update({ where: { id: profile.id }, data: { lastContentRequestedAt: now } });
    generated += 1;
  }

  return { due: due.length, processed: batch.length, generated, failed, skipped };
}
