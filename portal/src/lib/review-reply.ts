import 'server-only';
import type { GoogleBusinessConnection, GoogleReview } from '@prisma/client';
import { prisma } from './prisma';
import { getValidAccessToken, publishReviewReply } from './google-business';
import { generateReviewReplyDraft } from './review-reply-ai';
import { logError } from './observability';

// =============================================================================
// WP-22c — orchestrates publishing a reply (human-approved or automatic)
// and the auto-publish sweep hooked into google-review-sync.ts. Kept
// separate from google-business.ts (pure Google API calls) and
// review-reply-ai.ts (pure drafting) — this file is the only place that
// combines "who approved this" with "actually send it to Google".
// =============================================================================

export type PublishReplyOutcome =
  | { ok: true }
  | { ok: false; error: 'not_active' | 'needs_reconnect' | 'no_access_token' | 'api_error'; detail?: string };

/**
 * Publishes exactly `comment` — never re-reads GoogleReview.aiDraftReply
 * from the DB. This is what satisfies the AC "un borrador editado por el
 * cliente antes de aprobar se publica tal cual quedó editado": the
 * caller (the publish route, or the auto-publish sweep) always forwards
 * whatever text it currently has in hand.
 */
export async function publishReplyToReview(
  connection: GoogleBusinessConnection,
  review: Pick<GoogleReview, 'id' | 'googleReviewId'>,
  comment: string,
  approvedBy: string,
): Promise<PublishReplyOutcome> {
  // AC: publishing while the connection needs reconnection fails with a
  // specific, actionable error — not a generic one.
  if (connection.status !== 'active') {
    return { ok: false, error: connection.status === 'needs_reconnect' ? 'needs_reconnect' : 'not_active' };
  }

  const accessToken = await getValidAccessToken(connection);
  if (!accessToken) {
    // getValidAccessToken already flips the connection to needs_reconnect
    // on invalid_grant (WP-21) — the caller can re-check connection
    // status if it wants the specific reason.
    return { ok: false, error: 'no_access_token' };
  }

  const result = await publishReviewReply(accessToken, review.googleReviewId, comment);
  if (!result.ok) {
    return result.error === 'needs_reconnect'
      ? { ok: false, error: 'needs_reconnect' }
      : { ok: false, error: 'api_error', detail: result.detail };
  }

  const now = new Date();
  await prisma.googleReview.update({
    where: { id: review.id },
    data: {
      replyComment: comment,
      replyUpdatedAt: now,
      replyApprovedBy: approvedBy,
      replyApprovedAt: now,
      replyPublishedAt: now,
    },
  });
  return { ok: true };
}

/**
 * WP-22c auto-publish sweep. For every synced review with no existing
 * reply (Google's own or ours) and no draft attempted yet, drafts a
 * reply and — only when the connection has autoPublishReplies enabled —
 * publishes it immediately with approvedBy='auto'. A no-op when the
 * setting is off. Called from google-review-sync.ts right after a
 * successful sync; never throws and never aborts on one review's
 * failure — each is isolated and logged.
 */
export async function autoReplyToUnansweredReviews(
  connection: GoogleBusinessConnection,
  businessName: string,
): Promise<{ drafted: number; published: number }> {
  if (!connection.autoPublishReplies) return { drafted: 0, published: 0 };

  const candidates = await prisma.googleReview.findMany({
    where: { connectionId: connection.id, replyComment: null, aiDraftReply: null },
  });

  let drafted = 0;
  let published = 0;
  for (const review of candidates) {
    try {
      const draftResult = await generateReviewReplyDraft({
        businessName,
        reviewerName: review.reviewerName,
        starRating: review.starRating,
        comment: review.comment,
      });
      if (!draftResult.ok || 'skipped' in draftResult) continue;

      drafted += 1;
      await prisma.googleReview.update({
        where: { id: review.id },
        data: { aiDraftReply: draftResult.draft, aiDraftGeneratedAt: new Date() },
      });

      const publishResult = await publishReplyToReview(connection, review, draftResult.draft, 'auto');
      if (publishResult.ok) {
        published += 1;
      } else {
        logError('review_reply.auto_publish_failed', new Error(publishResult.error), {
          route: 'lib/review-reply.ts',
          connectionId: connection.id,
          reviewId: review.id,
        });
      }
    } catch (err) {
      logError('review_reply.auto_reply_sweep_item_failed', err, {
        route: 'lib/review-reply.ts',
        connectionId: connection.id,
        reviewId: review.id,
      });
    }
  }
  return { drafted, published };
}
