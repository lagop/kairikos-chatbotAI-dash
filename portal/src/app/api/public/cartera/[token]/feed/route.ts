import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { findSiteByFeedToken, loadFeedRows } from '@/lib/cartera/site';
import { buildFeed, etagMatches } from '@/lib/cartera/feed';
import { allowFeedRead } from '@/lib/cartera/public-http';
import { portalBaseUrl } from '@/lib/portal-base-url';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/public/cartera/[token]/feed — la cartera de una agencia en el
 * formato propio, versión 1 (lib/cartera/schema.ts):
 *   { version: 1, generatedAt, ventas: [...], alquileres: [...] }
 *
 * La lee el build de la web en GitHub Actions, no el navegador del comprador:
 * por eso no lleva CORS (el token va en los secretos de GitHub, nunca en el
 * HTML, y así ningún navegador puede leerlo aunque alguien lo pegue en una
 * página). Solo con la contratación activa; si no, 404.
 *
 * Con ETag sobre el contenido (sin generatedAt): un build que pregunta con
 * If-None-Match y nada ha cambiado recibe un 304.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;
  if (!allowFeedRead(token)) return NextResponse.json({ error: 'too_many_requests' }, { status: 429 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });

  const site = await findSiteByFeedToken(prisma, token);
  if (!site) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const rows = await loadFeedRows(prisma, site.id);
  const { feed, skipped, etag } = buildFeed(rows, { baseUrl: portalBaseUrl() });
  if (skipped.length > 0) {
    // No debería pasar: el panel guarda en `errors` lo que no valida. Si pasa,
    // la casa se queda fuera en vez de tumbar el build entero.
    logError('cartera.feed', 'casas publicables que no validan, fuera del feed', { siteId: site.id, refs: skipped.map((s) => s.ref) }, 'warn');
  }

  const headers = { ETag: etag, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  if (etagMatches(req.headers.get('if-none-match'), etag)) return new NextResponse(null, { status: 304, headers });
  return NextResponse.json(feed, { headers });
}
