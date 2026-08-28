import 'server-only';
import { prisma } from './prisma';

// =============================================================================
// SEO con IA — global product settings, read/written on SeoSettings'
// singleton row. Started with a single knob: how often
// lib/seo-content-generation.ts requests a new article per client.
//
// Fixed at 1 article/client/30 days at launch; the marketing copy
// promises 8-12/month. Raising the cadence raises cost and operator
// review load roughly linearly (every request is one n8n/LLM
// generation, every draft is one thing an operator has to read before
// it can publish), so it's an operator-configurable setting rather than
// a hardcoded constant — the operator can dial it in against real
// budget/review-capacity, not a guess baked into the code.
// =============================================================================

// A fixed, well-known id — this table only ever has one row. Upserted,
// never created via a real UUID generator, so there is never a question
// of "which row is the real settings row."
export const SEO_SETTINGS_SINGLETON_ID = '00000000-0000-0000-0000-000000000001';

// ~10 articles/month, the middle of the marketing copy's 8-12 range —
// used only as a bootstrap default before an operator has ever saved a
// value (see getContentGenerationMinIntervalDays's fallback chain).
export const DEFAULT_CONTENT_GENERATION_MIN_INTERVAL_DAYS = 3;

export const MIN_CONTENT_GENERATION_INTERVAL_DAYS = 1;
export const MAX_CONTENT_GENERATION_INTERVAL_DAYS = 90;

/**
 * Resolution order: the SeoSettings row (an operator has saved a value
 * via /admin/portal/settings/seo) → SEO_CONTENT_GENERATION_MIN_INTERVAL_DAYS
 * env var (a deploy-time bootstrap value, set once and never touched
 * through the UI) → DEFAULT_CONTENT_GENERATION_MIN_INTERVAL_DAYS. The DB
 * row wins once it exists so the settings page is never silently
 * overridden by a stale env var.
 */
export async function getContentGenerationMinIntervalDays(): Promise<number> {
  const row = await prisma.seoSettings.findUnique({ where: { id: SEO_SETTINGS_SINGLETON_ID } });
  if (row) return row.contentGenerationMinIntervalDays;

  const envValue = Number(process.env.SEO_CONTENT_GENERATION_MIN_INTERVAL_DAYS);
  if (Number.isFinite(envValue) && envValue > 0) return envValue;

  return DEFAULT_CONTENT_GENERATION_MIN_INTERVAL_DAYS;
}

export async function updateContentGenerationMinIntervalDays(days: number, actorEmail: string | null): Promise<void> {
  await prisma.seoSettings.upsert({
    where: { id: SEO_SETTINGS_SINGLETON_ID },
    create: { id: SEO_SETTINGS_SINGLETON_ID, contentGenerationMinIntervalDays: days, updatedBy: actorEmail },
    update: { contentGenerationMinIntervalDays: days, updatedBy: actorEmail },
  });
}
