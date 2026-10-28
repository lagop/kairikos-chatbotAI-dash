import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES, type SiteContentSampleName } from '@/lib/site-content-samples';
import { renderSiteFiles, type SiteTemplatePart, type SiteTemplateSource } from '@/lib/site-template';
import type { SiteContent } from '@/lib/site-content';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { parseTemplateStyle } from '@/lib/site-style';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Webs con IA, entrega 2 (27/10/2026) — GET /api/admin/portal/site-templates/[id]/preview
//
// Una plantilla pintada con un contenido de muestra (?contenido=normal |
// exagerado | minimo). «base» es la plantilla hecha a mano.
//
// ?comprobar=1 la sirve SIN el <script> de la plantilla: es la versión que
// mide el navegador del operador. Sin JavaScript todo tiene que verse (la
// regla de las animaciones), y sin animaciones las medidas no dependen de en
// qué momento de la transición se tomen.
//
// La foto de portada es la del sector de muestra servida por el portal: la
// vista previa no se publica en ninguna parte.
//
// ?acento=%23rrggbb y ?tipografia=<pareja> la pintan con el color o la letra
// de un negocio (site-style.ts): el laboratorio mide así las muestras y las
// parejas que ofrece la plantilla, no solo su versión original.
// =============================================================================

export async function GET(req: NextRequest, props: { params: Promise<{ templateId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let template: SiteTemplateSource = SITE_TEMPLATE_BASE;
  let foto = '/web-draft/trades.jpg';
  if (params.templateId !== 'base') {
    if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
    const row = await prisma.siteTemplate.findUnique({ where: { id: params.templateId }, select: { marco: true, secciones: true, estilo: true, sector: true } });
    if (!row || !row.marco) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    // 28/10/2026 — con la foto de SU sector: una de belleza medida con la de
    // una obra se ve rara y no dice nada de cómo quedará.
    if (row.sector && ['beauty', 'trades', 'health', 'food', 'professional'].includes(row.sector)) foto = `/web-draft/${row.sector}.jpg`;
    template = { marco: row.marco, secciones: row.secciones as Partial<Record<SiteTemplatePart, string>>, estilo: parseTemplateStyle(row.estilo) };
  }

  const requested = req.nextUrl.searchParams.get('contenido') ?? 'normal';
  const sample = (requested in SITE_CONTENT_SAMPLES ? requested : 'normal') as SiteContentSampleName;
  // Las fotos de muestra son rutas del sitio publicado (assets/…); aquí no
  // existen, así que se sirve la del sector, como la portada.
  const content = JSON.parse(JSON.stringify(SITE_CONTENT_SAMPLES[sample]).replaceAll('"assets/portada.jpg"', JSON.stringify(foto))) as SiteContent;
  // Entrega 5: ?pagina=blog o ?pagina=blog/entrada-1 (las comprobaciones
  // miden también la lista y el artículo). Vacío, la portada.
  const pagina = (req.nextUrl.searchParams.get('pagina') ?? '').replace(/^\/+|\/+$/g, '');
  const acento = (req.nextUrl.searchParams.get('acento') ?? '').toLowerCase();
  const tipografia = req.nextUrl.searchParams.get('tipografia') ?? '';
  content.estilo = { acento: /^#[0-9a-f]{6}$/.test(acento) ? acento : '', tipografia: /^[a-z0-9-]{1,30}$/.test(tipografia) ? tipografia : '' };
  if (req.nextUrl.searchParams.get('comprobar') === '1') {
    template = { ...template, marco: template.marco.replace(/<script\b[\s\S]*?<\/script>/gi, '') };
  }

  let html: string;
  try {
    const files = renderSiteFiles(template, content, {
      ...SAMPLE_RENDER_CONTEXT,
      fotos: { portada: foto, equipo: null, trabajo: null },
    });
    const file = files.find((f) => f.path === (pagina ? `${pagina}/index.html` : 'index.html'));
    if (!file) return NextResponse.json({ error: 'page_not_found' }, { status: 404 });
    html = file.content.toString('utf8');
  } catch (err) {
    return NextResponse.json({ error: 'render_failed', detail: err instanceof Error ? err.message : '' }, { status: 422 });
  }
  return new NextResponse(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
