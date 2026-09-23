import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { buildWebsiteFiles } from '@/lib/website-build';
import type { WebDraftCopy } from '@/lib/web-draft-ai';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/admin/portal/websites/[websiteId]/preview
 *
 * La página tal y como se va a publicar, servida desde el portal. Existe
 * para mirar antes de subir: publicar toca el servidor de un tercero, y
 * descubrir una errata cuando ya está en su dominio es peor.
 *
 * Se construye con la MISMA función que publica (buildWebsiteFiles), no con
 * una copia parecida. Una vista previa que no sea exactamente lo que se sube
 * es peor que no tener vista previa, porque da confianza falsa.
 *
 * Ojo con la portada: aquí se sirve solo el index.html, así que la imagen
 * —que en el sitio publicado viaja como assets/portada.jpg— no se ve. Es
 * aceptable: lo que se revisa aquí son los textos.
 */
export async function GET(req: NextRequest, { params }: { params: { websiteId: string } }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const website = await prisma.clientWebsite.findUnique({ where: { id: params.websiteId } });
  if (!website) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const files = await buildWebsiteFiles({
    businessName: website.businessName,
    primaryType: website.primaryType,
    themeKey: website.themeKey,
    phone: website.phone,
    address: website.address,
    city: website.city,
    copy: website.copy as unknown as WebDraftCopy,
    generatedAt: new Date(),
  });

  const index = files.find((f) => f.path === 'index.html');
  if (!index) return NextResponse.json({ error: 'build_failed' }, { status: 500 });

  return new NextResponse(index.content.toString('utf8'), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}
