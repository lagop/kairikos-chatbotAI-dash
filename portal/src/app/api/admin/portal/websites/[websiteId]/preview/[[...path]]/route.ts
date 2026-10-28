import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { publicOrigin } from '@/lib/public-origin';
import { serveWebsitePreview } from '@/lib/website-preview';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/portal/websites/[websiteId]/preview/…
 *
 * La web tal y como se va a publicar, servida desde el portal, para mirar
 * antes de subir: publicar toca el servidor de un tercero, y descubrir una
 * errata cuando ya está en su dominio es peor.
 *
 * Se construye con la MISMA función que publica (buildFilesForWebsite) y,
 * desde el 28/10/2026, con la misma vista previa navegable que el cliente
 * (website-preview.ts): fotos, logo, páginas interiores y legales. Antes solo
 * servía el index.html, sin la foto de portada.
 *
 * La vista previa enseña lo mismo que se va a publicar, integraciones
 * incluidas: si el teléfono va a cambiar por el de recall, el operador tiene
 * que verlo ANTES de subirlo. El destino del formulario es la dirección
 * PÚBLICA: detrás del proxy, el origin de la petición es la red interna.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ websiteId: string; path?: string[] }> }) {
  const params = await props.params;
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const website = await prisma.clientWebsite.findUnique({ where: { id: params.websiteId } });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Compatibilidad con los enlaces de antes: ?pagina=servicios.
  const pagina = (req.nextUrl.searchParams.get('pagina') ?? '').replace(/^\/+|\/+$/g, '');
  const path = params.path?.length ? params.path : pagina ? pagina.split('/') : undefined;
  return serveWebsitePreview(prisma, website, path, {
    mount: `/api/admin/portal/websites/${params.websiteId}/preview/`,
    portalOrigin: publicOrigin(req),
  });
}
