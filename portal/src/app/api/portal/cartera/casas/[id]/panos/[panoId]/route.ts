import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isUuid, requireCarteraPortal } from '@/lib/cartera/portal-auth';
import { readPhotoFile } from '@/lib/cartera/photos';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/portal/cartera/casas/[id]/panos/[panoId] — la foto 360° para el
 * panel, como ../../fotos/[photoId]: con la sesión de la agencia, solo de SU
 * sitio (también de sus borradores) y con caché privada.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string; panoId: string }> }) {
  const ctx = await requireCarteraPortal('read');
  if (!ctx.ok) return ctx.response;
  const { id, panoId } = await props.params;
  if (!isUuid(id) || !isUuid(panoId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const pano = await prisma.carteraPano.findFirst({
    where: { id: panoId.toLowerCase(), homeId: id.toLowerCase(), home: { siteId: ctx.site.id } },
    select: { storageKey: true, mime: true },
  });
  const file = pano ? await readPhotoFile(pano.storageKey) : null;
  if (!pano || !file) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return new NextResponse(new Uint8Array(file), {
    headers: { 'Content-Type': pano.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
  });
}
