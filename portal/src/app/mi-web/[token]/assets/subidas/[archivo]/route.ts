import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isShareToken } from '@/lib/prospecting-share';
import { serveDraftImage } from '@/lib/web-draft-images';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /mi-web/[token]/assets/subidas/[archivo] — 31/10/2026
 *
 * Las fotos que el operador subió al borrador pedido en kairikos.com
 * (lib/web-draft-images.ts), para la página de /mi-web/[token].
 *
 * Se sirven también ANTES de enviarlo, aunque la página enseñe entonces «lo
 * estamos preparando»: la vista en vivo del editor y «Ver borrador» las piden
 * aquí mientras el operador lo retoca. No enseña nada que no sea suyo: quien
 * tiene el testigo es el propio negocio, y son fotos de su negocio.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ token: string; archivo: string }> }) {
  const params = await props.params;
  const notFound = () => new NextResponse('No encontrada.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (!isShareToken(params.token)) return notFound();
  if (!isDatabaseConfigured) return new NextResponse('No disponible.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  try {
    return await serveDraftImage(prisma, { kind: 'public', where: { token: params.token } }, `assets/subidas/${params.archivo}`);
  } catch (err) {
    logError('public_draft.image_view_failed', err, { route: 'app/mi-web/[token]/assets/subidas/[archivo]' }, 'warn');
    return notFound();
  }
}
