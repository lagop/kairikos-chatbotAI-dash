import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { authenticateAdminRequest } from '@/lib/operator-session';
import { issueReviewFeedToken, revokeReviewFeedToken } from '@/lib/review-feed';
import { portalBaseUrl } from '@/lib/portal-base-url';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ action: z.enum(['issue', 'revoke']) });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/admin/portal/google-business/[connectionId]/web-feed
 *   { action: 'issue' }  → { feedUrl }: la URL con el token, la ÚNICA vez que se enseña.
 *                          Sustituye a la anterior, que deja de valer.
 *   { action: 'revoke' } → ninguna web puede leer ya las reseñas de esta ficha.
 *
 * Reseñas en la web Premium (lib/review-feed.ts). Solo operador: la URL va al
 * secreto REVIEWS_FEED_URL del repositorio de la web, que crea el propietario.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ connectionId: string }> }) {
  const auth = await authenticateAdminRequest(req);
  if (!auth.ok) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured) return NextResponse.json({ error: 'service_unavailable' }, { status: 503 });
  const { connectionId } = await props.params;
  if (!UUID_RE.test(connectionId)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  try {
    if (body.data.action === 'issue') {
      const r = await issueReviewFeedToken(prisma, { connectionId, baseUrl: portalBaseUrl() });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 404 });
      return NextResponse.json({ ok: true, feedUrl: r.feedUrl }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const r = await revokeReviewFeedToken(prisma, { connectionId });
    if (!r.ok) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError('review_feed.admin_failed', err, { connectionId });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
