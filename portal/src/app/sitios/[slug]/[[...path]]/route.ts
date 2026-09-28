import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Producto Web, Fase 1 — GET /sitios/[slug]/...
 *
 * Sirve la web de un cliente alojada en nuestra infraestructura. Pública,
 * obviamente: esto ES su web, y quien entra es un cliente suyo.
 *
 * Existe para quien no tiene alojamiento propio, que es justo el caso en el
 * que no se le puede vender una web de otra manera. Quien sí lo tiene se
 * publica por SFTP en su servidor, que sigue siendo el destino por defecto.
 *
 * Esta dirección con slug es la PROVISIONAL, la que permite enseñar la web el
 * mismo día sin esperar a un DNS. Cuando el cliente apunte su dominio aquí,
 * el proxy resolverá por cabecera Host contra ClientWebsite.customDomain
 * — el certificado lo emite Caddy por su cuenta, y esa parte es
 * configuración de la VPS, no código de este repositorio.
 *
 * Solo sirve sitios PUBLICADOS: un borrador no está en internet hasta que
 * alguien pulsa publicar, y esa regla no puede depender de que nadie adivine
 * el slug.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { slug: string; path?: string[] } },
) {
  if (!isDatabaseConfigured) {
    return new NextResponse('No disponible.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  // Sin ruta, index.html. Con ruta, lo que pidan — pero solo de ESTE sitio:
  // el path se usa como clave junto al websiteId, así que un '../' no lleva
  // a ninguna parte, no hay sistema de ficheros detrás.
  const requested = (params.path ?? []).join('/') || 'index.html';

  try {
    const site = await prisma.clientWebsite.findFirst({
      where: { slug: params.slug, status: 'published' },
      select: { id: true },
    });
    if (!site) {
      return new NextResponse('Página no encontrada.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const file = await prisma.clientWebsiteFile.findUnique({
      where: { websiteId_path: { websiteId: site.id, path: requested } },
    });
    if (!file) {
      return new NextResponse('Página no encontrada.', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    return new NextResponse(new Uint8Array(file.content), {
      status: 200,
      headers: {
        'content-type': file.contentType,
        // Caché corta: es la web de un negocio, cambia poco, pero cuando el
        // cliente publica una corrección quiere verla ya. Cinco minutos es
        // el punto en el que ninguna de las dos cosas molesta.
        'cache-control': 'public, max-age=300',
      },
    });
  } catch (err) {
    // Quien abre esto es un cliente del negocio: un 500 con traza es la peor
    // cara posible. Mismo criterio que /r/[requestId].
    logError('client_website.serve_failed', err, { slug: params.slug }, 'warn');
    return new NextResponse('No hemos podido mostrar esta página.', {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}
