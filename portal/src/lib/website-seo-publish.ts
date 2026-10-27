import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { parseSiteContent, slugify, type SiteBlogEntry, type SiteContent } from './site-content';
import { sanitizeArticleHtml, toPlainText } from './seo-article-html';
import { publicSiteUrl, publishWebsite } from './website-publish';
import { resolveContractedInstance } from './client-product-access';

// =============================================================================
// Webs con IA, entrega 6 (27/10/2026) — el SEO publica en una web de Kairikos.
//
// Hasta hoy el último paso del SEO (seo-content-review.ts) solo sabía llamar
// a la API de WordPress; un cliente con nuestra web y el SEO contratado se
// quedaba con cada artículo en 'publish_failed: missing_wordpress_credentials'.
// Con SeoProfile.websiteId puesto, el artículo aprobado se convierte en una
// entrada del blog de SU web (origen 'seo') y la web se vuelve a publicar.
//
// Tres decisiones:
// - Idempotente por seoDraftId. Reintentar un 'publish_failed' actualiza la
//   misma entrada; nunca la duplica (el fallo de WordPress del 22/09 fue
//   justo un artículo publicado dos veces).
// - La entrada se GUARDA aunque la web no se pueda publicar ahora (datos de
//   ejemplo sin confirmar, datos legales que faltan, un SFTP caído). El
//   artículo ya lo aprobaron dos personas; lo que falla es la web, y saldrá
//   con la siguiente publicación. El borrador queda en 'publish_failed' con
//   el motivo de la web, para que se vea y se pueda reintentar.
// - El HTML se limpia aquí (sanitizeArticleHtml) y otra vez al pintarlo.
// =============================================================================

export type SeoWebsitePublishResult =
  | { ok: true; url: string | null; slug: string }
  | { ok: false; error: string; savedSlug?: string };

function uniqueEntrySlug(base: string, taken: Set<string>): string {
  const root = base || 'articulo';
  let slug = root;
  for (let n = 2; taken.has(slug); n++) slug = `${root}-${n}`;
  return slug;
}

/** Pura: el contenido con la entrada del artículo añadida o actualizada. */
export function upsertSeoEntry(
  content: SiteContent,
  draft: { id: string; title: string; bodyHtml: string; metaDescription: string | null },
  today: string,
): { content: SiteContent; entry: SiteBlogEntry } {
  const next: SiteContent = JSON.parse(JSON.stringify(content));
  const existing = next.blog.entradas.find((e) => e.seoDraftId === draft.id);
  const titulo = toPlainText(draft.title).slice(0, 120) || 'Artículo';
  const fields = {
    titulo,
    metaDescripcion: toPlainText(draft.metaDescription ?? '').slice(0, 160),
    html: sanitizeArticleHtml(draft.bodyHtml).slice(0, 60000),
    texto: '',
    publicada: true,
    origen: 'seo' as const,
  };
  if (existing) {
    // La dirección y la fecha se conservan: puede haber enlaces a ella.
    Object.assign(existing, fields);
    return { content: next, entry: existing };
  }
  const entry: SiteBlogEntry = {
    slug: uniqueEntrySlug(slugify(titulo), new Set(next.blog.entradas.map((e) => e.slug))),
    metaTitulo: '',
    fecha: today,
    extracto: '',
    foto: '',
    fotoAlt: '',
    seoDraftId: draft.id,
    ...fields,
  };
  next.blog.entradas.unshift(entry);
  return { content: next, entry };
}

/**
 * Guarda el artículo como entrada del blog de la web y la vuelve a publicar.
 * Nunca lanza.
 */
export async function publishSeoDraftToWebsite(
  prisma: PrismaClient,
  websiteId: string,
  draft: { id: string; title: string; bodyHtml: string; metaDescription: string | null },
  now: Date = new Date(),
): Promise<SeoWebsitePublishResult> {
  try {
    const website = await prisma.clientWebsite.findUnique({
      where: { id: websiteId },
      select: { id: true, clientId: true, tenantId: true, content: true, publishTarget: true, slug: true, customDomain: true },
    });
    if (!website) return { ok: false, error: 'website_not_found' };
    if (website.content == null) return { ok: false, error: 'website_not_v2' };
    const parsed = parseSiteContent(website.content);
    if (!parsed.ok) return { ok: false, error: 'website_invalid_content' };
    if (parsed.content.blog.entradas.length >= 200 && !parsed.content.blog.entradas.some((e) => e.seoDraftId === draft.id)) {
      return { ok: false, error: 'blog_full' };
    }

    const { content, entry } = upsertSeoEntry(parsed.content, draft, now.toISOString().slice(0, 10));
    const valid = parseSiteContent(content);
    if (!valid.ok) return { ok: false, error: 'entry_invalid' };

    await prisma.$transaction(async (tx) => {
      await tx.clientWebsite.update({ where: { id: website.id }, data: { content: valid.content as unknown as object } });
      await tx.clientWebsiteAudit.create({
        data: {
          websiteId: website.id,
          clientId: website.clientId,
          tenantId: website.tenantId,
          action: 'seo_entry_published',
          after: { slug: entry.slug, seoDraftId: draft.id },
          actorType: 'system',
          actorEmail: 'system:seo',
        },
      });
    });

    const published = await publishWebsite(prisma, website.id, { type: 'system', email: 'system:seo' }, now);
    if (!published.ok) return { ok: false, error: `website_${published.error}`, savedSlug: entry.slug };

    const portalOrigin = process.env.NEXT_PUBLIC_PORTAL_URL || 'https://portal.kairikos.cloud';
    const base = publicSiteUrl(website, valid.content.urlPublica, portalOrigin);
    return { ok: true, slug: entry.slug, url: base ? `${base}blog/${entry.slug}/` : null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'website_publish_error' };
  }
}

// ---- Títulos y descripciones con un clic ---------------------------------------

export type SeoWebsiteContext =
  | {
      ok: true;
      profileId: string;
      businessDescription: string | null;
      website: { id: string; clientId: string; tenantId: string | null; businessName: string; city: string | null; updatedAt: Date };
      content: SiteContent;
    }
  | { ok: false; error: 'forbidden' | 'not_kairikos_website' | 'website_not_found' | 'website_invalid_content'; status: number };

/**
 * La web de Kairikos a la que apunta el SEO contratado de este cliente, ya
 * comprobado que todo es suyo: el contrato de SEO (resolveContractedInstance)
 * y la web (por clientId, nunca por lo que mande el navegador).
 */
export async function resolveSeoWebsite(
  prisma: PrismaClient,
  clientId: string,
  clientProductId: string | null,
): Promise<SeoWebsiteContext> {
  const instance = await resolveContractedInstance(prisma, { clientId, productCode: 'seo', clientProductId });
  if (!instance) return { ok: false, error: 'forbidden', status: 403 };
  const profile = await prisma.seoProfile.findUnique({
    where: { clientProductId: instance.clientProductId },
    select: { id: true, cmsType: true, websiteId: true, businessDescription: true },
  });
  if (!profile || profile.cmsType !== 'kairikos' || !profile.websiteId) return { ok: false, error: 'not_kairikos_website', status: 409 };
  const website = await prisma.clientWebsite.findFirst({
    where: { id: profile.websiteId, clientId },
    select: { id: true, clientId: true, tenantId: true, businessName: true, city: true, content: true, updatedAt: true },
  });
  if (!website) return { ok: false, error: 'website_not_found', status: 404 };
  const parsed = parseSiteContent(website.content);
  if (!parsed.ok) return { ok: false, error: 'website_invalid_content', status: 409 };
  const { content: _content, ...rest } = website;
  return { ok: true, profileId: profile.id, businessDescription: profile.businessDescription, website: rest, content: parsed.content };
}

// ---- Search Console sin tocar nada ------------------------------------------------

/**
 * Verifica la web en el Search Console del cliente (google-site-verification.ts):
 * pide el código de la etiqueta, lo pone en la portada, publica, y le pide a
 * Google que compruebe y añada la propiedad. Nunca lanza. El código se queda
 * puesto aunque falle un paso posterior: Google lo vuelve a mirar de vez en
 * cuando, y quitarlo haría perder la verificación.
 */
export async function verifyWebsiteInSearchConsole(
  prisma: PrismaClient,
  websiteId: string,
  accessToken: string,
  siteUrl: string,
  steps: {
    getToken: (accessToken: string, siteUrl: string) => Promise<{ ok: true; value: string } | { ok: false; error: string }>;
    verify: (accessToken: string, siteUrl: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    addSite: (accessToken: string, siteUrl: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const token = await steps.getToken(accessToken, siteUrl);
    if (!token.ok) return { ok: false, error: `token:${token.error}` };

    const website = await prisma.clientWebsite.findUnique({ where: { id: websiteId }, select: { id: true, clientId: true, tenantId: true, content: true } });
    if (!website) return { ok: false, error: 'website_not_found' };
    const parsed = parseSiteContent(website.content);
    if (!parsed.ok) return { ok: false, error: 'website_invalid_content' };
    if (parsed.content.verificacionGoogle !== token.value) {
      const content = { ...parsed.content, verificacionGoogle: token.value };
      await prisma.$transaction(async (tx) => {
        await tx.clientWebsite.update({ where: { id: website.id }, data: { content: content as unknown as object } });
        await tx.clientWebsiteAudit.create({
          data: {
            websiteId: website.id,
            clientId: website.clientId,
            tenantId: website.tenantId,
            action: 'search_console_verification',
            after: { siteUrl },
            actorType: 'system',
            actorEmail: 'system:seo',
          },
        });
      });
    }
    const published = await publishWebsite(prisma, website.id, { type: 'system', email: 'system:seo' });
    if (!published.ok) return { ok: false, error: `website_${published.error}` };

    const verified = await steps.verify(accessToken, siteUrl);
    if (!verified.ok) return { ok: false, error: `verify:${verified.error}` };
    const added = await steps.addSite(accessToken, siteUrl);
    if (!added.ok) return { ok: false, error: `add_site:${added.error}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 200) : 'verification_error' };
  }
}
