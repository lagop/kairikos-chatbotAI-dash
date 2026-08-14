import { NextResponse, type NextRequest } from 'next/server';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { logError } from '@/lib/observability';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * WP-22b — GET /r/[requestId]
 *
 * The link every review-request email actually contains. Deliberately
 * public — the person clicking is the business's own customer, who has
 * no Kairikos account and no session. Records the first click
 * (`ReviewRequest.clickedAt`, the AC's conversion measure) then 302s
 * straight to Google's review page for that location. An unknown or
 * already-expired request id still redirects somewhere useful (Google's
 * homepage) rather than showing a broken link — the recipient has no way
 * to act on an error page anyway. That fallback has to cover a Prisma
 * connectivity failure too, not just "row not found" — a customer
 * clicking a real email link is the last audience who should ever see a
 * 500, so the lookup is wrapped in try/catch rather than letting a
 * transient DB outage surface as a crash.
 */
export async function GET(_req: NextRequest, { params }: { params: { requestId: string } }) {
  const fallback = 'https://www.google.com';
  if (!isDatabaseConfigured) {
    return NextResponse.redirect(fallback);
  }

  let reviewUrl: string | null | undefined;
  let request: { id: string; clickedAt: Date | null } | null = null;
  try {
    const found = await prisma.reviewRequest.findUnique({
      where: { id: params.requestId },
      select: {
        id: true,
        clickedAt: true,
        campaign: { select: { connection: { select: { reviewUrl: true } } } },
      },
    });
    request = found;
    reviewUrl = found?.campaign.connection.reviewUrl;
  } catch (err) {
    logError('review_request.click_redirect', err, { route: 'GET /r/[requestId]', requestId: params.requestId }, 'warn');
    return NextResponse.redirect(fallback);
  }
  if (!request || !reviewUrl) {
    return NextResponse.redirect(fallback);
  }

  if (!request.clickedAt) {
    await prisma.reviewRequest
      .update({ where: { id: request.id }, data: { clickedAt: new Date() } })
      .catch(() => null);
  }

  return NextResponse.redirect(reviewUrl);
}
