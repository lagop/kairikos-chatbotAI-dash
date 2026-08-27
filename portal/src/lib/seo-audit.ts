import 'server-only';

// =============================================================================
// SEO con IA, Fase A — the operator's diagnostic tool: technical signals
// from a client's own website (meta tags, headings, image alt text, a
// bounded broken-link check). Pure I/O + regex extraction, no LLM — same
// "not a DOM parser" posture as prospecting-enrichment.ts's crawlWebsite
// (the target is readable signals, not a faithful HTML parse). A
// self-contained fetch helper rather than importing crawlWebsite: that
// one returns stripped plain text, this needs the raw HTML to find
// specific tags, and duplicating ~15 lines of fetch/timeout plumbing
// here is cheaper than reshaping an already-merged, tested function's
// return type for a second, different consumer.
//
// Operator-triggered, on demand — the monthly automated version (Fase C)
// reuses this same function, just called from a cron tick instead of a
// button click.
// =============================================================================

const AUDIT_TIMEOUT_MS = 8_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; KairikosSeoBot/1.0; +https://kairikos.com)';
const MAX_H1_TEXTS = 10;
const MAX_BROKEN_LINKS = 20;
/** Internal links only — external link-checking is slower, less
 *  reliable, and less actionable for the client's own site. Sequential,
 *  not concurrent: this is a low-frequency, operator-triggered
 *  diagnostic, not a hot path, so the simplicity is worth the wall-time. */
const LINK_CHECK_CAP = 10;
const LINK_CHECK_TIMEOUT_MS = 3_000;

export interface SeoAuditResult {
  title: string | null;
  metaDescription: string | null;
  h1Count: number;
  h1Texts: string[];
  imagesTotal: number;
  imagesMissingAlt: number;
  linksInternal: number;
  linksExternal: number;
  brokenLinksChecked: number;
  brokenLinks: { url: string; status: number | null }[];
  checkedAt: string;
}

export type AuditWebsiteResult = { ok: true; data: SeoAuditResult } | { ok: false; error: string };

async function fetchPageHtml(url: string): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType && !contentType.includes('text/html')) {
      return { ok: false, error: `unsupported_content_type:${contentType}` };
    }
    return { ok: true, html: await res.text() };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return { ok: false, error: isAbort ? 'timeout' : err instanceof Error ? err.message : 'unknown_error' };
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ');
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  const text = decodeEntities(stripTags(m[1])).trim();
  return text || null;
}

function extractMetaDescription(html: string): string | null {
  const m =
    html.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) ??
    html.match(/<meta\s+[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i);
  if (!m) return null;
  const text = decodeEntities(m[1]).trim();
  return text || null;
}

function countH1s(html: string): number {
  return Array.from(html.matchAll(/<h1[^>]*>/gi)).length;
}

function extractH1Texts(html: string): string[] {
  return Array.from(html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi))
    .map((m) => decodeEntities(stripTags(m[1])).trim())
    .filter(Boolean)
    .slice(0, MAX_H1_TEXTS);
}

function extractImages(html: string): { total: number; missingAlt: number } {
  const imgTags = Array.from(html.matchAll(/<img\s[^>]*>/gi)).map((m) => m[0]);
  let missingAlt = 0;
  for (const tag of imgTags) {
    const altMatch = tag.match(/\salt=["']([^"']*)["']/i);
    if (!altMatch || altMatch[1].trim() === '') missingAlt += 1;
  }
  return { total: imgTags.length, missingAlt };
}

function extractLinks(html: string, baseUrl: string): { internal: string[]; external: string[] } {
  const base = new URL(baseUrl);
  const hrefs = Array.from(html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>/gi)).map((m) => m[1]);
  const internal: string[] = [];
  const external: string[] = [];
  for (const href of hrefs) {
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript):/i.test(href)) continue;
    try {
      const resolved = new URL(href, base);
      if (resolved.origin === base.origin) internal.push(resolved.toString());
      else external.push(resolved.toString());
    } catch {
      // Malformed href — skip it rather than fail the whole audit over one bad link.
    }
  }
  return { internal, external };
}

async function checkLinkStatus(url: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function auditWebsite(url: string): Promise<AuditWebsiteResult> {
  const page = await fetchPageHtml(url);
  if (!page.ok) {
    return { ok: false, error: page.error };
  }
  const { html } = page;

  const { total: imagesTotal, missingAlt: imagesMissingAlt } = extractImages(html);
  const { internal, external } = extractLinks(html, url);

  const toCheck = internal.slice(0, LINK_CHECK_CAP);
  const brokenLinks: { url: string; status: number | null }[] = [];
  for (const link of toCheck) {
    const status = await checkLinkStatus(link);
    if (status === null || status >= 400) {
      brokenLinks.push({ url: link, status });
      if (brokenLinks.length >= MAX_BROKEN_LINKS) break;
    }
  }

  return {
    ok: true,
    data: {
      title: extractTitle(html),
      metaDescription: extractMetaDescription(html),
      h1Count: countH1s(html),
      h1Texts: extractH1Texts(html),
      imagesTotal,
      imagesMissingAlt,
      linksInternal: internal.length,
      linksExternal: external.length,
      brokenLinksChecked: toCheck.length,
      brokenLinks,
      checkedAt: new Date().toISOString(),
    },
  };
}
