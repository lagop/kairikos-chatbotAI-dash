import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { allowReviewFeedRead, readReviewFeed } from '@/lib/review-feed';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/resenas/[token]/feed — las reseñas de Google de una ficha,
 * en el formato de las webs Premium (docs/resenas.md de la plantilla dental;
 * reglas en lib/review-feed-rules.ts).
 *
 * La lee la build de la web en GitHub Actions cada noche, no el navegador:
 * sin CORS, y el token va en los secretos del repositorio, nunca en el HTML.
 *
 *   200  el feed
 *   404  token desconocido (o retirado): la build falla y la web sigue como estaba
 *   410  Reseñas ya no está contratado o la ficha se desconectó: la web se
 *        publica sin reseñas (la plantilla lo trata como «sin datos», no como error)
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  if (!allowReviewFeedRead(token)) return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' };
  try {
    const r = await readReviewFeed(prisma, token);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.error === 'gone' ? 410 : 404, headers });
    return NextResponse.json(r.feed, { headers });
  } catch (err) {
    logError('review_feed.read_failed', err, { route: 'api/public/resenas/[token]/feed' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500, headers });
  }
}
