import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES, type SiteContentSampleName } from '@/lib/site-content-samples';
import { renderSitePage, type SiteTemplatePart, type SiteTemplateSource } from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';

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
// =============================================================================

export async function GET(req: NextRequest, props: { params: Promise<{ templateId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let template: SiteTemplateSource = SITE_TEMPLATE_BASE;
  if (params.templateId !== 'base') {
    if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
    const row = await prisma.siteTemplate.findUnique({ where: { id: params.templateId }, select: { marco: true, secciones: true } });
    if (!row || !row.marco) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    template = { marco: row.marco, secciones: row.secciones as Partial<Record<SiteTemplatePart, string>> };
  }

  const requested = req.nextUrl.searchParams.get('contenido') ?? 'normal';
  const sample = (requested in SITE_CONTENT_SAMPLES ? requested : 'normal') as SiteContentSampleName;
  const content = SITE_CONTENT_SAMPLES[sample];
  if (req.nextUrl.searchParams.get('comprobar') === '1') {
    template = { ...template, marco: template.marco.replace(/<script\b[\s\S]*?<\/script>/gi, '') };
  }

  let html: string;
  try {
    html = renderSitePage(template, content, content.paginas[0], {
      ...SAMPLE_RENDER_CONTEXT,
      fotos: { portada: '/web-draft/trades.jpg', equipo: null, trabajo: null },
    });
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
