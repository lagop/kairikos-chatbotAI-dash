import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { buildFilesForWebsite } from '@/lib/website-publish';
import { publicOrigin } from '@/lib/public-origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/portal/websites/[websiteId]/preview
 *
 * La página tal y como se va a publicar, servida desde el portal. Existe
 * para mirar antes de subir: publicar toca el servidor de un tercero, y
 * descubrir una errata cuando ya está en su dominio es peor.
 *
 * Se construye con la MISMA función que publica (buildFilesForWebsite), no con
 * una copia parecida. Una vista previa que no sea exactamente lo que se sube
 * es peor que no tener vista previa, porque da confianza falsa.
 *
 * Ojo con la portada: aquí se sirve solo el index.html, así que la imagen
 * —que en el sitio publicado viaja como assets/portada.jpg— no se ve. Es
 * aceptable: lo que se revisa aquí son los textos.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ websiteId: string }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const website = await prisma.clientWebsite.findUnique({ where: { id: params.websiteId } });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // La vista previa enseña lo mismo que se va a publicar, integraciones
  // incluidas (buildFilesForWebsite las resuelve): si el teléfono va a
  // cambiar por el de recall, el operador tiene que verlo ANTES de subirlo.
  const built = await buildFilesForWebsite(prisma, website, {
    // El destino del formulario tiene que ser la dirección PÚBLICA: detrás
    // del proxy, el origin de la petición es la red interna de Docker.
    portalOrigin: publicOrigin(req),
    now: new Date(),
  });
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: 500 });

  // Con varias páginas (webs con IA), ?pagina=servicios enseña esa.
  const ruta = (req.nextUrl.searchParams.get('pagina') ?? '').replace(/^\/+|\/+$/g, '');
  const index = built.files.find((f) => f.path === (ruta ? `${ruta}/index.html` : 'index.html'));
  if (!index) return NextResponse.json({ error: ruta ? 'page_not_found' : 'build_failed' }, { status: ruta ? 404 : 500 });

  // Las tipografías sí: las enlaza relativas (fuentes/…, viajan con la web) y
  // aquí no se sirven; las mismas están en /fuentes/ del portal. Sin esto el
  // operador revisaría la web con la tipografía de respaldo.
  const html = index.content.toString('utf8').replace(/href="(?:\.\.\/)*fuentes\//g, 'href="/fuentes/');
  return new NextResponse(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
