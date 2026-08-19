import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { getSession } from '@/lib/session';
import { isProductContracted } from '@/lib/client-product-access';
import { publishReplyToReview } from '@/lib/review-reply';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({ comment: z.string().trim().min(1).max(4000) });

/**
 * WP-22c — POST /api/portal/google-business/reviews/[reviewId]/publish
 *
 * Publishes exactly `body.comment` — whatever the client is currently
 * looking at in their editor, not whatever aiDraftReply says in the DB.
 * That's the AC: an edited draft publishes as edited. approvedBy is
 * always a real client id here (never 'auto' — that value is reserved
 * for the sync-triggered auto-publish path, which never calls this
 * route).
 */
export async function POST(req: NextRequest, { params }: { params: { reviewId: string } }) {
  const session = await getSession();
  if (!session.hasClientAccess) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const hasReviews = await isProductContracted(prisma, resolved.clientId, 'reviews');
  if (!hasReviews) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: 'invalid_body', details: body.error.flatten() }, { status: 400 });
  }

  const review = await prisma.googleReview.findUnique({ where: { id: params.reviewId } });
  if (!review || review.clientId !== resolved.clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const connection = await prisma.googleBusinessConnection.findUnique({ where: { id: review.connectionId } });
  if (!connection) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const result = await publishReplyToReview(connection, review, body.data.comment, `client:${resolved.clientId}`);
  if (!result.ok) {
    // AC: needs_reconnect gets its own clear status/message, not a
    // generic failure.
    const status = result.error === 'needs_reconnect' ? 409 : result.error === 'not_active' ? 409 : 502;
    return NextResponse.json({ error: result.error, detail: result.detail }, { status });
  }

  return NextResponse.json({ published: true });
}
