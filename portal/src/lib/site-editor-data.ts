import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { parseSiteContent, type SiteContent } from './site-content';
import { SITE_TEMPLATE_BASE } from './site-template-base';
import { templateIconIds } from './web-draft-design';
import { editorStyleOptions, parseTemplateStyle } from './site-style';
import { templateIconSymbols, type IconSymbol } from './site-icon-symbols';
import type { SiteTemplateSource } from './site-template';

// Lo que necesita el editor de una web v2 (SiteContentEditor) además del
// contenido: los iconos y los colores y letras que admite su plantilla. Lo
// cargan la página del cliente (/portal/web/[id]) y, desde el 28/10/2026, la
// del operador (/admin/portal/[clientId]/web/[websiteId]), que editan con el
// mismo editor. Null si la web no tiene contenido v2 o no se puede leer.
export async function loadSiteEditorData(
  prisma: PrismaClient,
  site: { content: unknown; templateId: string | null },
): Promise<{ content: SiteContent; iconIds: string[]; iconSymbols: IconSymbol[]; estilo: ReturnType<typeof editorStyleOptions>; campos: SiteEditorExtraField[] } | null> {
  if (site.content == null) return null;
  const parsed = parseSiteContent(site.content);
  if (!parsed.ok) return null;
  const tpl = site.templateId ? await prisma.siteTemplate.findUnique({ where: { id: site.templateId }, select: { marco: true, secciones: true, estilo: true } }) : null;
  return {
    content: parsed.content,
    iconIds: templateIconIds(tpl?.marco ?? SITE_TEMPLATE_BASE.marco),
    // 29/10/2026 — los dibujos, para elegir el icono viéndolo.
    iconSymbols: templateIconSymbols(tpl?.marco ?? SITE_TEMPLATE_BASE.marco),
    estilo: editorStyleOptions(parseTemplateStyle(tpl?.estilo)),
    campos: templateExtraFields(tpl ? { marco: tpl.marco, secciones: (tpl.secciones ?? {}) as SiteTemplateSource['secciones'] } : SITE_TEMPLATE_BASE),
  };
}

/** 03/11/2026 — los campos que solo pintan algunas plantillas (hoy Circuito,
 *  copiados de su landing): el editor los enseña si la plantilla del cliente
 *  los usa, y así nadie rellena unas acreditaciones que su web no saca. La
 *  palabra resaltada del titular y la nota del precio no están: las pinta el
 *  motor (o todas las plantillas) y salen siempre. */
export type SiteEditorExtraField = 'sellos' | 'guardia' | 'proceso.icono' | 'zona.tiempo';

/** ¿Nombra la plantilla ese campo en una etiqueta ({{x}}, {{#x}}, {{^x}}, {{{x}}})? */
const usa = (src: string, campo: string) => new RegExp(`\\{\\{[#^{]?\\s*${campo}\\b`).test(src);

export function templateExtraFields(tpl: SiteTemplateSource): SiteEditorExtraField[] {
  const partes = Object.entries(tpl.secciones ?? {});
  const todo = [tpl.marco, ...partes.map(([, html]) => html ?? '')].join('\n');
  // El icono de los pasos se busca solo en las partes del proceso: {{icono}}
  // sale también en servicios y en los bloques.
  const proceso = partes.filter(([parte]) => parte === 'proceso' || parte.startsWith('proceso@')).map(([, html]) => html ?? '').join('\n');
  const campos: SiteEditorExtraField[] = [];
  if (usa(todo, 'sellos')) campos.push('sellos');
  if (usa(todo, 'guardia')) campos.push('guardia');
  if (usa(proceso, 'icono')) campos.push('proceso.icono');
  if (usa(todo, 'zona\\.con_tiempos') || usa(todo, 'tiempo')) campos.push('zona.tiempo');
  return campos;
}
