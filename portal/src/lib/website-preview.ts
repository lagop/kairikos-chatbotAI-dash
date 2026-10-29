import 'server-only';
import { NextResponse } from 'next/server';
import type { PrismaClient } from '@prisma/client';
import { buildFilesForWebsite, contentTypeFor } from './website-publish';
import { resolveRequestedFile, rewriteRelativeUrls } from './hosted-site-paths';
import { SITE_UPLOAD_PATH_RE } from './site-content';

// =============================================================================
// La vista previa navegable de una web, antes de publicarla. Se construye con
// la misma función que publica (buildFilesForWebsite) y se sirve el archivo
// pedido de ese mismo conjunto, así que la foto, las páginas interiores y las
// legales se ven y se puede navegar entre ellas. Las rutas relativas se
// reescriben bajo `mount` (hosted-site-paths.ts). Nunca indexable.
//
// La usan el cliente (/api/portal/website/[id]/preview/…) y, desde el
// 28/10/2026, el operador (/api/admin/portal/websites/[id]/preview/…), que
// antes solo veía el index.html sin foto. Quién puede ver qué web lo decide
// cada ruta antes de llamar aquí.
//
// 29/10/2026 — y la vista previa EN VIVO del editor: con `override`, la web
// se construye con lo que el cliente está escribiendo (sin guardar) en modo
// edición, y se devuelve solo el HTML de la página pedida. Las fotos y las
// tipografías de esa página se piden después por la vista previa de siempre.
// =============================================================================

type WebsiteForPreview = Parameters<typeof buildFilesForWebsite>[1];

/** Lo que el editor manda para la vista previa en vivo: lo que hay en el
 *  formulario, sin guardar. Se valida al construir (parseSiteContent). */
export interface PreviewOverride {
  content: unknown;
  phone: string | null;
  address: string | null;
}

/** El cuerpo de un POST de vista previa en vivo, o null si no es uno. */
export function parsePreviewOverride(body: unknown): PreviewOverride | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (!b.content || typeof b.content !== 'object') return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return { content: b.content, phone: str(b.phone, 50), address: str(b.address, 300) };
}

export async function serveWebsitePreview(
  prisma: PrismaClient,
  website: WebsiteForPreview,
  pathSegments: string[] | undefined,
  options: { mount: string; portalOrigin: string; override?: PreviewOverride },
): Promise<NextResponse> {
  // Una imagen subida (site-uploads.ts) se sirve tal cual, sin construir la
  // web entera: el editor enseña la miniatura en cuanto se sube, antes de
  // guardar, cuando el contenido todavía no la cita.
  const requested = resolveRequestedFile(pathSegments);
  if (SITE_UPLOAD_PATH_RE.test(requested)) {
    const image = await prisma.clientWebsiteImage.findUnique({
      where: { websiteId_path: { websiteId: website.id, path: requested } },
      select: { contentType: true, content: true },
    });
    if (!image) return new NextResponse('No encontrada.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    return new NextResponse(new Uint8Array(image.content), {
      status: 200,
      headers: { 'content-type': image.contentType, 'cache-control': 'private, max-age=3600', 'x-robots-tag': 'noindex, nofollow', 'x-content-type-options': 'nosniff' },
    });
  }

  const built = options.override
    ? await buildFilesForWebsite(
        prisma,
        { ...website, content: options.override.content, phone: options.override.phone, address: options.override.address },
        { portalOrigin: options.portalOrigin, now: new Date(), edicion: true },
      )
    : await buildFilesForWebsite(prisma, website, { portalOrigin: options.portalOrigin, now: new Date() });
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 500 });

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
    const html = rewriteRelativeUrls(page, `${options.mount}${dir}`)
      // Es una vista previa: que no la indexe nadie aunque alguien la enlace.
      .replace(/<\/head>/i, '<meta name="robots" content="noindex, nofollow">\n</head>');
    body = new TextEncoder().encode(html);
  }
  return new NextResponse(body, {
    status: 200,
    headers: { 'content-type': contentType, 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}
