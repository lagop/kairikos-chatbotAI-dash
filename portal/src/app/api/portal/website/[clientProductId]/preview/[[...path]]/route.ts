import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { buildFilesForWebsite, contentTypeFor } from '@/lib/website-publish';
import { publicOrigin } from '@/lib/public-origin';
import { resolveRequestedFile, rewriteRelativeUrls } from '@/lib/hosted-site-paths';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// =============================================================================
// Webs con IA, entrega 4 (27/10/2026) — GET /api/portal/website/[id]/preview/…
//
// El cliente ve su web ANTES de publicarla, tal y como saldría: se construye
// con la misma función que publica (buildFilesForWebsite) y se sirve el
// archivo pedido de ese mismo conjunto, así que la foto, las páginas
// interiores y las legales se ven y se puede navegar entre ellas. Las rutas
// relativas se reescriben bajo esta dirección (hosted-site-paths.ts).
//
// Solo la del propio cliente: el clientId sale de la sesión y se cruza con el
// de la URL. Nunca indexable.
// =============================================================================

export async function GET(req: NextRequest, props: { params: Promise<{ clientProductId: string; path?: string[] }> }) {
  const params = await props.params;
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const resolved = await resolveClientFromSession();
  if (!resolved || resolved.source !== 'database') return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const website = await prisma.clientWebsite.findFirst({
    where: { clientProductId: params.clientProductId, clientId: resolved.clientId },
  });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const built = await buildFilesForWebsite(prisma, website, { portalOrigin: publicOrigin(req), now: new Date() });
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 500 });

  const requested = resolveRequestedFile(params.path);
  const file = built.files.find((f) => f.path === requested);
  if (!file) return new NextResponse('Página no encontrada.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

  const contentType = contentTypeFor(file.path);
  let body: Uint8Array = new Uint8Array(file.content);
  if (contentType.startsWith('text/html')) {
    const dir = requested.includes('/') ? `${requested.slice(0, requested.lastIndexOf('/'))}/` : '';
    // Las tipografías, de /fuentes/ del portal (son los mismos archivos que
    // viajan con la web): pedirlas por aquí reconstruiría la web entera una
    // vez por cada archivo de tipografía.
    const page = file.content.toString('utf8').replace(/href="(?:\.\.\/)*fuentes\//g, 'href="/fuentes/');
    const html = rewriteRelativeUrls(page, `/api/portal/website/${params.clientProductId}/preview/${dir}`)
      // Es una vista previa: que no la indexe nadie aunque alguien la enlace.
      .replace(/<\/head>/i, '<meta name="robots" content="noindex, nofollow">\n</head>');
    body = new TextEncoder().encode(html);
  }
  return new NextResponse(body, {
    status: 200,
    headers: { 'content-type': contentType, 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}
