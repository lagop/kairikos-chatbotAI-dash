import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from './observability';
import { parseSiteContent, type SiteContent } from './site-content';
import { buildSiteContentFromDraft, expandDraftToSiteContent } from './site-content-ai';
import { atribucionGoogleHtml, renderCitasHtml, renderResenasHtml } from './site-draft-markup';
import { renderSitePage, sectionHasContent, type SiteRenderContext, type SiteTemplatePart, type SiteTemplateSource } from './site-template';
import { alternarVariantes } from './site-section-variants';
import { pickSiteTemplateForSector } from './site-template-jobs';
import { withSectorExamples } from './site-sector-blocks';
import { editorStyleOptions, parseTemplateStyle } from './site-style';
import type { WebDraftCopy } from './web-draft-ai';
import { withDraftUploadsBase } from './web-draft-images';
import {
  DEFAULT_WEB_DRAFT_OFFER,
  MIN_RATING_TO_SHOW,
  formatSpanishPhone,
  heroImageUrls,
  primaryTypeLabel,
  themeForVariant,
  type WebDraftOffer,
  type WebDraftPurchaseCta,
  type WebDraftSubject,
} from './web-draft-html';

// =============================================================================
// Webs con IA, entrega 3 (27/10/2026) — el borrador del prospecto con una
// plantilla de diseño de la biblioteca.
//
// Al generar (barrido, «regenerar» del operador, «Ver cómo quedaría mi web»):
// si el sector tiene una plantilla APROBADA, el texto de web-draft-ai.ts se
// amplía al contenido completo (site-content-ai.ts) y se guardan contenido y
// plantilla junto al copy. Si no la tiene, nada cambia: el borrador sale de
// copy con la plantilla de código, como hasta hoy. Así la primera plantilla
// aprobada es lo que enciende esto, sector a sector, sin un despliegue.
//
// Al servir (/borrador, /mi-web, la vista del operador): lo de Google llega
// en vivo como siempre (web-draft-live.ts) y aquí se convierte en el
// contexto del motor; la banda de Kairikos y la oferta «La quiero» van con sus
// estilos en línea, porque son nuestras y no del diseño de su web.
//
// Si algo falla al pintar (plantilla que no está, contenido que no valida),
// devuelve null y quien llama pinta el borrador de siempre: un prospecto
// nunca debe encontrarse una página rota.
// =============================================================================

/** Los iconos del sprite de una plantilla, sin el «i-». */
export function templateIconIds(marco: string): string[] {
  return Array.from(new Set(Array.from(marco.matchAll(/<symbol[^>]*\sid="i-([a-z0-9-]+)"/g), (m) => m[1])));
}

/**
 * 31/10/2026 — el borrador nuevo sale con las disposiciones ya alternadas,
 * lo mismo que el botón «Alternar disposiciones» del editor
 * (alternarVariantes): dos secciones seguidas no se ven iguales.
 *
 * Una sección sale si tiene contenido (sectionHasContent, la misma regla que
 * al pintar). Las opiniones no se pueden saber aquí: las reseñas llegan de
 * Google al servir el borrador. Se cuentan como visibles, que es lo habitual
 * en un prospecto de Places. La semilla, del nombre del negocio: estable al
 * regenerar el mismo borrador, distinta entre negocios.
 */
export function conDisposicionesAlternadas(content: SiteContent, businessName: string): SiteContent {
  const view = { ...content.datos, valoracion: '1', resenas_html: '' };
  const semilla = Array.from(businessName).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  return {
    ...content,
    paginas: content.paginas.map((p) => ({
      ...p,
      secciones: alternarVariantes(p.secciones, {
        semilla,
        seVe: (r) => r.tipo === 'bloque' || sectionHasContent(r.tipo, view),
      }),
    })),
  };
}

async function loadTemplate(prisma: PrismaClient, id: string): Promise<SiteTemplateSource | null> {
  const row = await prisma.siteTemplate.findUnique({ where: { id }, select: { marco: true, secciones: true, estilo: true } });
  return row?.marco
    ? { marco: row.marco, secciones: row.secciones as Partial<Record<SiteTemplatePart, string>>, estilo: parseTemplateStyle(row.estilo) }
    : null;
}

/**
 * Contenido y plantilla para un borrador recién generado, o null si su sector
 * no tiene plantilla aprobada. Si la ampliación con IA falla, el contenido
 * sale solo con lo que ya había (titular, servicios…): menos rico, pero con
 * el diseño de la biblioteca (`expanded: false`). Nunca lanza.
 *
 * `leadId`: al regenerar, el borrador que se sustituye no cuenta en el
 * reparto entre plantillas (pickSiteTemplateForSector).
 *
 * `templateId` fija la plantilla en vez de dejar que la elija el sector
 * (convertir un borrador antiguo a una concreta): tiene que estar aprobada y
 * ser de su sector, o devuelve null.
 */
export async function designForDraft(
  prisma: PrismaClient,
  input: { copy: WebDraftCopy; themeKey: string; businessName: string; primaryType: string | null; city: string | null; templateId?: string; leadId?: string },
): Promise<{ content: SiteContent; templateId: string; expanded: boolean } | null> {
  try {
    const sector = input.themeKey.split('-')[0];
    const picked = input.templateId
      ? await prisma.siteTemplate.findFirst({ where: { id: input.templateId, sector, estado: 'aprobada' }, select: { id: true } })
      : await pickSiteTemplateForSector(prisma, sector, { exceptDraftLeadId: input.leadId });
    if (!picked) return null;
    const template = await loadTemplate(prisma, picked.id);
    if (!template) return null;
    const iconIds = templateIconIds(template.marco);
    const estilo = editorStyleOptions(template.estilo ?? null);
    const expanded = await expandDraftToSiteContent({
      businessName: input.businessName,
      kind: primaryTypeLabel(input.primaryType),
      city: input.city,
      copy: input.copy,
      iconIds,
      estilo,
    });
    const base = expanded.ok && !('skipped' in expanded) ? expanded.content : buildSiteContentFromDraft(input.copy, null, iconIds);
    // 28/10/2026 — galería, servicios por pestañas… con contenido de ejemplo,
    // marcado como tal (site-sector-blocks.ts).
    const content = conDisposicionesAlternadas(
      withSectorExamples(base, { familia: sector, businessName: input.businessName, primaryType: input.primaryType }),
      input.businessName,
    );
    if (!expanded.ok) logError('web_draft_design.expand_failed', new Error(expanded.error), {}, 'warn');
    return { content, templateId: picked.id, expanded: expanded.ok && !('skipped' in expanded) };
  } catch (err) {
    logError('web_draft_design.failed', err, {}, 'warn');
    return null;
  }
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const FONT = "font:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif";

/** La banda de arriba: qué es esta página. Mismos colores que la del
 *  borrador de siempre (web-draft-html.ts), que ya funciona en las llamadas. */
export function draftBannerHtml(businessName: string, purchase: WebDraftPurchaseCta | null, shareUrl: string | null): string {
  return `<div style="background:#111827;color:#fff;padding:10px 16px;${FONT};font-size:13px;text-align:center">Propuesta de Kairikos para <strong style="color:#ffd166">${esc(
    businessName,
  )}</strong> · borrador con sus datos públicos de Google, todavía no publicado${
    purchase?.kind === 'buy' ? ` · <a href="#oferta" style="color:#ffd166;font-weight:600;white-space:nowrap">La quiero</a>` : ''
  }${shareUrl ? `<br><span style="color:#9aa6b8">Enlace para mandarle: <code style="color:#cfe0ff;word-break:break-all">${esc(shareUrl)}</code></span>` : ''}</div>`;
}

/** La oferta del final: comprarla sin llamada o, sin hueco este mes, una
 *  llamada. Mismo texto que el borrador de siempre. */
export function draftOfferHtml(purchase: WebDraftPurchaseCta | null, offer: WebDraftOffer = DEFAULT_WEB_DRAFT_OFFER): string {
  if (!purchase) return '';
  const button =
    purchase.kind === 'buy'
      ? `<a href="${esc(purchase.href)}" data-kairikos="comprar" style="display:inline-block;background:#ffd166;color:#111827;font-weight:700;text-decoration:none;border-radius:999px;padding:12px 24px">La quiero · ${esc(purchase.priceLabel)}</a>`
      : `<a href="${esc(purchase.href)}" target="_blank" rel="noopener" data-kairikos="llamada" style="display:inline-block;background:#ffd166;color:#111827;font-weight:700;text-decoration:none;border-radius:999px;padding:12px 24px">Reservar una llamada</a>`;
  const text =
    purchase.kind === 'buy'
      ? `<h2 style="margin:0 0 8px;font-size:24px">¿Le gusta? Puede ser suya</h2><p style="margin:0 0 16px">Su web publicada: ${esc(
          offer.priceLabel,
        )}, con dominio y alojamiento el primer año incluidos. La repasamos con usted y la publicamos unos días después de que dé el visto bueno.</p>`
      : `<h2 style="margin:0 0 8px;font-size:24px">¿Le gusta?</h2><p style="margin:0 0 16px">Este mes ya no nos quedan huecos para webs sin llamada. Reserve veinte minutos y la vemos juntos.</p>`;
  return `<section id="oferta" style="background:#111827;color:#fff;padding:48px 16px;text-align:center;${FONT}"><div style="max-width:640px;margin:0 auto">${text}${button}</div></section>`;
}

/** El contexto del motor a partir del sujeto del borrador (con lo que llegó
 *  de Google en vivo). Exportado para las pruebas. */
export function draftRenderContext(params: {
  subject: WebDraftSubject;
  themeKey: string;
  purchase?: WebDraftPurchaseCta | null;
  offer?: WebDraftOffer;
  shareUrl?: string | null;
}): SiteRenderContext {
  const { subject } = params;
  const showRating =
    subject.rating !== null && subject.reviewCount !== null && subject.reviewCount > 0 && subject.rating >= MIN_RATING_TO_SHOW;
  const reviews = (subject.reviews ?? []).slice(0, 3);
  const highlights = (subject.highlights ?? []).slice(0, 4);
  const [photo] = heroImageUrls(themeForVariant(params.themeKey).theme, subject);
  return {
    negocio: {
      nombre: subject.businessName,
      telefono: subject.phone ? formatSpanishPhone(subject.phone) : null,
      direccion: subject.address,
      mapsUrl: subject.googleMapsUri ?? null,
      valoracion: showRating ? subject.rating!.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : null,
      numResenas: showRating ? new Intl.NumberFormat('es-ES').format(subject.reviewCount!) : null,
    },
    fotos: { portada: photo, equipo: null, trabajo: null },
    formAction: null,
    borrador: true,
    bannerHtml: draftBannerHtml(subject.businessName, params.purchase ?? null, params.shareUrl ?? null),
    footerHtml: draftOfferHtml(params.purchase ?? null, params.offer),
    citasHtml: highlights.length >= 2 ? renderCitasHtml(highlights) : null,
    resenasHtml: reviews.length ? renderResenasHtml(reviews) : null,
    atribucionGoogleHtml: reviews.length || highlights.length >= 2 || showRating ? atribucionGoogleHtml(reviews.length > 0) : null,
    horario: (subject.hours ?? []).map((h) => ({ dias: h.days, horas: h.hours })),
  };
}

/**
 * El borrador pintado con su plantilla, o null si no se puede (quien llama
 * pinta entonces el de siempre). Nunca lanza.
 */
export async function renderDesignedDraft(
  prisma: PrismaClient,
  params: {
    templateId: string | null;
    content: unknown;
    subject: WebDraftSubject;
    themeKey: string;
    purchase?: WebDraftPurchaseCta | null;
    offer?: WebDraftOffer;
    shareUrl?: string | null;
    /** 30/10/2026 — la vista en vivo del editor del operador
     *  (web-draft-editor.ts): los textos marcados para editarlos en sitio. */
    edicion?: boolean;
    /** 31/10/2026 — dónde se sirven las fotos subidas al borrador
     *  (draftUploadsBase, web-draft-images.ts). Sin él, se quedan relativas. */
    subidasBase?: string | null;
  },
): Promise<string | null> {
  if (!params.templateId || params.content == null) return null;
  try {
    const parsed = parseSiteContent(params.content);
    if (!parsed.ok) return null;
    const template = await loadTemplate(prisma, params.templateId);
    if (!template) return null;
    const html = renderSitePage(template, parsed.content, parsed.content.paginas[0], { ...draftRenderContext(params), edicion: params.edicion });
    return params.subidasBase ? withDraftUploadsBase(html, params.subidasBase) : html;
  } catch (err) {
    logError('web_draft_design.render_failed', err, { templateId: params.templateId }, 'warn');
    return null;
  }
}
