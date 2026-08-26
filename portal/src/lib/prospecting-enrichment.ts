import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { deliverChannelEvent } from './channel-webhook';
import { logError } from './observability';

// =============================================================================
// Prospección con IA, Fase B — website enrichment. For each outbound Lead
// Google Places found a website for, the portal crawls that website and
// hands the raw text to n8n, which extracts contact details with its own
// LLM and calls back PATCH /api/internal/leads/[id]/enrich — see that
// route and the session's own plan. The portal/n8n boundary from the rest
// of this codebase holds here too: crawling is I/O, "who is the owner and
// what's their email" is interpretation, and interpretation is n8n's job,
// never done inline in the portal.
//
// Single attempt per lead (Lead.enrichmentRequestedAt), not a retry
// machine: a delivery to n8n that fails is retried by the EXISTING
// ChannelWebhookDelivery backoff sweep (sync-channel-webhooks) since this
// reuses that same plumbing — no new retry logic needed there. A crawl
// that fails outright (site down, DNS failure, timeout) is different: a
// business's website being unreachable is usually a standing fact, not a
// transient one, so it is logged and left alone rather than retried every
// tick forever.
// =============================================================================

const CRAWL_TIMEOUT_MS = 8_000;
const MAX_RAW_TEXT_CHARS = 20_000;
/** Cap per cron tick — bounds how many third-party site fetches one
 *  prospecting-tick invocation can block on; a persistently slow site
 *  costs at most CRAWL_TIMEOUT_MS, not the whole tick. */
export const ENRICHMENT_BATCH_SIZE = 20;

const USER_AGENT = 'Mozilla/5.0 (compatible; KairikosProspectingBot/1.0; +https://kairikos.com)';

export type CrawlWebsiteResult = { ok: true; data: { rawText: string } } | { ok: false; error: string };

/**
 * Fetches a business's own website and reduces it to plain text for n8n's
 * LLM to read. Deliberately simple — a regex strip, not an HTML parser:
 * the target is "readable text a human visiting the contact page would
 * see", not a faithful DOM, and n8n's own extraction step is what
 * actually has to make sense of it.
 *
 * Does NOT check robots.txt — a known simplification (same honesty
 * convention as google-places.ts's own caveats), acceptable for v1
 * because this crawls a business's OWN site once, identified by an
 * honest User-Agent, to find the SAME contact details a human visitor
 * would — not a bulk or repeated scrape.
 */
export async function crawlWebsite(url: string): Promise<CrawlWebsiteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CRAWL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return { ok: false, error: `unsupported_content_type:${contentType}` };
    }
    const html = await res.text();
    return { ok: true, data: { rawText: htmlToText(html) } };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: isAbort ? 'timeout' : err instanceof Error ? err.message : 'unknown_error' };
  } finally {
    clearTimeout(timer);
  }
}

function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ');
  const decoded = withoutTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  const collapsed = decoded.replace(/\s+/g, ' ').trim();
  return collapsed.slice(0, MAX_RAW_TEXT_CHARS);
}

export interface EnrichmentSweepResult {
  processed: number;
  delivered: number;
  crawlFailed: number;
}

interface EnrichmentCandidate {
  id: string;
  clientId: string;
  website: string | null;
}

/**
 * The cron entry point (called from /api/cron/prospecting-tick). Picks up
 * to ENRICHMENT_BATCH_SIZE outbound leads that have a website and have
 * never been attempted, crawls each, and hands a success to
 * deliverChannelEvent under connectionType 'prospecting'. Every candidate
 * is stamped enrichmentRequestedAt when this function is done with it,
 * whether the crawl succeeded or not — see the module header for why a
 * failed crawl isn't retried.
 */
export async function sweepPendingEnrichment(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<EnrichmentSweepResult> {
  const candidates = (await prisma.lead.findMany({
    where: { source: 'outbound', website: { not: null }, enrichmentRequestedAt: null },
    orderBy: { createdAt: 'asc' },
    take: ENRICHMENT_BATCH_SIZE,
    select: { id: true, clientId: true, website: true },
  })) as EnrichmentCandidate[];

  let delivered = 0;
  let crawlFailed = 0;

  for (const lead of candidates) {
    // website is guaranteed non-null by the query's `not: null` filter —
    // narrowed here only for TypeScript.
    const website = lead.website;
    if (!website) continue;

    const crawl = await crawlWebsite(website);
    if (!crawl.ok) {
      crawlFailed += 1;
      logError('prospecting_enrichment.crawl_failed', new Error(crawl.error), { leadId: lead.id }, 'warn');
    } else {
      const result = await deliverChannelEvent({
        connectionType: 'prospecting',
        connectionId: lead.id,
        clientId: lead.clientId,
        payload: { leadId: lead.id, rawText: crawl.data.rawText },
      });
      if (result.ok) {
        delivered += 1;
      } else {
        // Not counted as crawlFailed — the crawl worked; delivery to n8n
        // is what failed, and that failure is already recorded in
        // ChannelWebhookDelivery for sync-channel-webhooks to retry with
        // the SAME payload (no need to crawl again).
        logError('prospecting_enrichment.delivery_failed', new Error(result.error ?? 'unknown'), { leadId: lead.id }, 'warn');
      }
    }

    await prisma.lead.update({ where: { id: lead.id }, data: { enrichmentRequestedAt: now } });
  }

  return { processed: candidates.length, delivered, crawlFailed };
}
