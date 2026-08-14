import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { generateReviewReplyDraft } from '@/lib/review-reply-ai';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * WP-22c — POST /api/portal/google-business/reviews/[reviewId]/draft
 * Generates (or regenerates) an AI draft reply and stores it on the
 * review row. This alone never publishes anything — see .../publish.
 */
export async function POST(_req: NextRequest, { params }: { params: { reviewId: string } }) {
  const resolved = await resolveClientFromSession();
  if (!resolved) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return NextResponse.json({ error: 'service_unavailable', detail: 'not_available_in_dev_mode' }, { status: 503 });
  }

  const hasReviews = await isProductContracted(prisma, resolved.clientId, 'reviews');
  if (!hasReviews) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const review = await prisma.googleReview.findUnique({ where: { id: params.reviewId } });
  if (!review || review.clientId !== resolved.clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const client = await prisma.chatbotClient.findUnique({
    where: { id: resolved.clientId },
    select: { companyName: true, name: true },
  });
  const businessName = client?.companyName ?? client?.name ?? 'Nuestro negocio';

  const result = await generateReviewReplyDraft({
    businessName,
    reviewerName: review.reviewerName,
    starRating: review.starRating,
    comment: review.comment,
  });

  if ('skipped' in result) {
    return NextResponse.json({ error: 'service_unavailable', detail: result.reason }, { status: 503 });
  }
  if (!result.ok) {
    return NextResponse.json({ error: 'draft_generation_failed', detail: result.error }, { status: 502 });
  }

  await prisma.googleReview.update({
    where: { id: review.id },
    data: { aiDraftReply: result.draft, aiDraftGeneratedAt: new Date() },
  });

  return NextResponse.json({ draft: result.draft });
}
