import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { parseSiteContent, type SiteContent } from './site-content';
import { SITE_TEMPLATE_BASE } from './site-template-base';
import { templateIconIds } from './web-draft-design';
import { editorStyleOptions, parseTemplateStyle } from './site-style';
import { templateIconSymbols, type IconSymbol } from './site-icon-symbols';

// Lo que necesita el editor de una web v2 (SiteContentEditor) además del
// contenido: los iconos y los colores y letras que admite su plantilla. Lo
// cargan la página del cliente (/portal/web/[id]) y, desde el 28/10/2026, la
// del operador (/admin/portal/[clientId]/web/[websiteId]), que editan con el
// mismo editor. Null si la web no tiene contenido v2 o no se puede leer.
export async function loadSiteEditorData(
  prisma: PrismaClient,
  site: { content: unknown; templateId: string | null },
): Promise<{ content: SiteContent; iconIds: string[]; iconSymbols: IconSymbol[]; estilo: ReturnType<typeof editorStyleOptions> } | null> {
  if (site.content == null) return null;
  const parsed = parseSiteContent(site.content);
  if (!parsed.ok) return null;
  const tpl = site.templateId ? await prisma.siteTemplate.findUnique({ where: { id: site.templateId }, select: { marco: true, estilo: true } }) : null;
  return {
    content: parsed.content,
    iconIds: templateIconIds(tpl?.marco ?? SITE_TEMPLATE_BASE.marco),
    // 29/10/2026 — los dibujos, para elegir el icono viéndolo.
    iconSymbols: templateIconSymbols(tpl?.marco ?? SITE_TEMPLATE_BASE.marco),
    estilo: editorStyleOptions(parseTemplateStyle(tpl?.estilo)),
  };
}
