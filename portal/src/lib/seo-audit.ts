import 'server-only';
import { Prisma, type PrismaClient } from '@prisma/client';
import { logError } from './observability';
import { safeFetch, BlockedUrlError } from './safe-fetch';

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
//
// Fase 5 — ese "reuses this same function, just called from a cron tick"
// nunca se construyó: auditWebsite() solo tenía UN llamante, la ruta del
// operador. Es la parte que "Cadena de entrega por producto" marcó
// automatizable ("es determinista y el scheduler ya lleva tres rutas de
// SEO"): sweepDueSiteAudits, al final de este archivo, es ese cron tick
// que faltaba. Vive aquí y no en un módulo aparte porque el comentario de
// arriba ya reservaba este sitio para él.
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
    // La URL es la web que escribió el cliente: safeFetch no deja que apunte
    // a la red interna, ni directamente ni por redirección.
    const res = await safeFetch(url, {
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
    if (err instanceof BlockedUrlError) return { ok: false, error: 'url_not_allowed' };
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
    // Los enlaces salen del HTML de la web del cliente: los mismos límites.
    // Uno prohibido cuenta como no comprobable (null), no como roto.
    const res = await safeFetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
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

// =============================================================================
// Fase 5 — el barrido automático.
// =============================================================================

/** Cada cuántos días toca reauditar. Semanal: los signos que auditWebsite
 *  mide (title, meta description, alt text, enlaces rotos) no cambian de
 *  un día para otro, y generate-seo-content.ts —que lee lastAuditResult
 *  como una de sus señales— corre como muy seguido cada
 *  MIN_CONTENT_GENERATION_INTERVAL_DAYS (1 día), así que semanal deja la
 *  auditoría razonablemente fresca sin auditar el sitio del cliente todos
 *  los días porque sí. */
export const SITE_AUDIT_MIN_INTERVAL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Misma forma que isGenerationDue en seo-content-generation.ts: pura,
 *  fácil de testear sin red ni Prisma. `null` (nunca auditado) siempre
 *  está due. */
export function isAuditDue(
  lastAuditAt: Date | null,
  minIntervalDays: number = SITE_AUDIT_MIN_INTERVAL_DAYS,
  now: Date = new Date(),
): boolean {
  if (!lastAuditAt) return true;
  // 2026-09-16 — usaba Date.now() aunque sweepDueSiteAudits recibe su propio
  // `now`: el barrido decidía con un reloj y registraba con otro. Solo se vio
  // cuando el calendario real dejó atrás la fecha fija del test.
  return now.getTime() - lastAuditAt.getTime() >= minIntervalDays * DAY_MS;
}

/** Techo de auditorías por tick. Cada una puede tardar decenas de
 *  segundos (la carga de la página más hasta LINK_CHECK_CAP comprobaciones
 *  de enlace secuenciales, 3s de timeout cada una) y la ruta de cron
 *  corre con maxDuration=60 — el mismo techo que
 *  MAX_GENERATIONS_PER_TICK en seo-content-generation.ts, y por el mismo
 *  motivo: lo que no entra en este tick sigue vencido y entra en el
 *  siguiente, cinco minutos después. */
const MAX_AUDITS_PER_TICK = 2;

export interface SiteAuditSweepResult {
  /** Perfiles con siteUrl, producto 'seo' activo, y auditoría vencida. */
  due: number;
  /** De ésos, los que de verdad se intentaron en este tick. */
  processed: number;
  audited: number;
  failed: number;
}

/**
 * El cron entry point (/api/cron/audit-seo-sites). Reaudita cada
 * SeoProfile con siteUrl que lleve más de SITE_AUDIT_MIN_INTERVAL_DAYS
 * sin auditoría (o nunca auditado), para un cliente con 'seo' activo.
 *
 * Un fallo (sitio caído, timeout) NO estampa lastAuditAt — igual que la
 * ruta del operador, deja lastAuditResult del último éxito intacto y dejo
 * lastAuditError con el motivo — así el siguiente tick lo reintenta en
 * vez de darlo por auditado con un error como único resultado. Aislado
 * por perfil: un sitio caído no puede impedir que se audite el resto.
 */
export async function sweepDueSiteAudits(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<SiteAuditSweepResult> {
  const profiles = await prisma.seoProfile.findMany({
    where: {
      siteUrl: { not: null },
      clientProduct: { status: 'active' },
    },
    select: { id: true, clientId: true, tenantId: true, siteUrl: true, lastAuditAt: true },
  });

  const due = profiles.filter((p) => isAuditDue(p.lastAuditAt, SITE_AUDIT_MIN_INTERVAL_DAYS, now));
  const batch = due.slice(0, MAX_AUDITS_PER_TICK);

  let audited = 0;
  let failed = 0;

  for (const profile of batch) {
    // `siteUrl: { not: null }` en el where ya lo garantiza; el guard
    // deja al compilador tranquilo sin un `!` a ciegas.
    if (!profile.siteUrl) continue;

    const result = await auditWebsite(profile.siteUrl);

    if (!result.ok) {
      failed += 1;
      logError('seo_audit_sweep.audit_failed', new Error(result.error), { clientId: profile.clientId }, 'warn');
      try {
        await prisma.seoProfile.update({ where: { id: profile.id }, data: { lastAuditError: result.error } });
      } catch (err) {
        logError('seo_audit_sweep.save_failure_failed', err, { clientId: profile.clientId }, 'warn');
      }
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.seoProfile.update({
          where: { id: profile.id },
          data: { lastAuditAt: now, lastAuditResult: result.data as unknown as Prisma.InputJsonValue, lastAuditError: null },
        });
        await tx.seoProfileAudit.create({
          data: {
            profileId: profile.id,
            clientId: profile.clientId,
            tenantId: profile.tenantId,
            action: 'audit_run',
            before: Prisma.JsonNull,
            after: {
              h1Count: result.data.h1Count,
              imagesMissingAlt: result.data.imagesMissingAlt,
              brokenLinksFound: result.data.brokenLinks.length,
            },
            // Fase 5 — tercer valor de actorType, junto a 'operator' y
            // 'client': ninguno de los dos escribió esta fila. El propio
            // modelo (ChatbotConfigStepAudit.actor) ya tenía precedente
            // de 'system' antes de esta sesión; SeoProfileAudit no, y
            // ahora sí.
            actorType: 'system',
            actorOperatorId: null,
            actorEmail: null,
          },
        });
      });
      audited += 1;
    } catch (err) {
      failed += 1;
      logError('seo_audit_sweep.save_failed', err, { clientId: profile.clientId }, 'warn');
    }
  }

  return { due: due.length, processed: batch.length, audited, failed };
}
