import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { findPublicPhoto, readPhotoFile } from '@/lib/cartera/photos';
import { etagMatches } from '@/lib/cartera/feed';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/cartera/foto/[photoId] — una foto de una casa publicada.
 *
 * La descarga el build de la web (astro:assets genera los tamaños), no el
 * navegador del comprador. Por id no adivinable y solo si la casa es
 * publicable y la agencia está activa; de un borrador, 404 (decisión A:
 * el fichero está en el volumen cartera-fotos, lib/cartera/photos.ts).
 *
 * Caché larga e inmutable: una foto nueva es un id nuevo, nunca se reescribe
 * el contenido de uno que ya existe. El ETag es su SHA-256.
 */
const NOT_FOUND = () => NextResponse.json({ error: 'not_found' }, { status: 404 });

export async function GET(req: NextRequest, props: { params: Promise<{ photoId: string }> }) {
  const { photoId } = await props.params;
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const photo = await findPublicPhoto(prisma, photoId);
  if (!photo) return NOT_FOUND();

  const etag = `"${photo.sha256}"`;
  const headers: Record<string, string> = {
    'Content-Type': photo.mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  };
  if (etagMatches(req.headers.get('if-none-match'), etag)) return new NextResponse(null, { status: 304, headers });

  const file = await readPhotoFile(photo.storageKey);
  if (!file) {
    // La fila existe y el fichero no: volumen sin montar, CARTERA_FOTOS_DIR
    // vacía o una copia restaurada a medias. Que se vea en los logs.
    logError('cartera.photo', 'foto sin fichero en el volumen', { photoId: photo.id }, 'warn');
    return NOT_FOUND();
  }
  return new NextResponse(new Uint8Array(file), { status: 200, headers: { ...headers, 'Content-Length': String(file.length) } });
}
