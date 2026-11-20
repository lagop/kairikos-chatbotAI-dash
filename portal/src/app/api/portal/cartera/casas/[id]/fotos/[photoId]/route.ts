import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isUuid, requireCarteraPortal } from '@/lib/cartera/portal-auth';
import { readPhotoFile } from '@/lib/cartera/photos';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/portal/cartera/casas/[id]/fotos/[photoId] — la foto para el panel.
 *
 * La ruta pública (/api/public/cartera/foto/…) solo sirve fotos de casas
 * publicadas, y en el panel la agente ve también las de sus borradores. Esta
 * va con su sesión, solo para fotos de SU sitio, y con caché privada.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string; photoId: string }> }) {
  const ctx = await requireCarteraPortal('read');
  if (!ctx.ok) return ctx.response;
  const { id, photoId } = await props.params;
  if (!isUuid(id) || !isUuid(photoId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const photo = await prisma.carteraPhoto.findFirst({
    where: { id: photoId.toLowerCase(), homeId: id.toLowerCase(), home: { siteId: ctx.site.id } },
    select: { storageKey: true, mime: true },
  });
  const file = photo ? await readPhotoFile(photo.storageKey) : null;
  if (!photo || !file) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return new NextResponse(new Uint8Array(file), {
    headers: { 'Content-Type': photo.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
  });
}
