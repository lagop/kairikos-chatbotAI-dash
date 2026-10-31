import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { isShareToken } from '@/lib/prospecting-share';
import { serveDraftImage } from '@/lib/web-draft-images';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /borrador/[token]/assets/subidas/[archivo] — 31/10/2026
 *
 * Las fotos que el operador subió al borrador (lib/web-draft-images.ts), para
 * la página de /borrador/[token]. Pública por lo mismo que la página: el
 * testigo es la llave, y con él no se alcanza nada más que este borrador.
 * Con las mismas condiciones que la página: si el borrador ya no se enseña
 * (el prospecto no tiene nombre, purgado), sus fotos tampoco.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ token: string; archivo: string }> }) {
  const params = await props.params;
  const notFound = () => new NextResponse('No encontrada.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  if (!isShareToken(params.token)) return notFound();
  if (!isDatabaseConfigured) return new NextResponse('No disponible.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  try {
    return await serveDraftImage(prisma, { kind: 'prospecting', where: { shareToken: params.token, lead: { contactName: { not: null } } } }, `assets/subidas/${params.archivo}`);
  } catch (err) {
    logError('web_draft.image_view_failed', err, { route: 'app/borrador/[token]/assets/subidas/[archivo]' }, 'warn');
    return notFound();
  }
}
