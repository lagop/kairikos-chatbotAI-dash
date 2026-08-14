import 'server-only';
import type { GoogleBusinessConnection } from '@prisma/client';
import { prisma } from './prisma';
import { getValidAccessToken } from './google-business';
import { logError } from './observability';

// =============================================================================
// WP-22a — pulls reviews for a connected Google Business Profile location
// (WP-21's GoogleBusinessConnection) into GoogleReview, idempotently.
//
// Uses the Reviews API (mybusiness.googleapis.com/v4) — the WP-20
// research confirmed this is still where review list/reply lives, even
// though account/location listing (WP-21) moved to the newer v1 APIs.
// Its parent path shape is DIFFERENT from the v1 location resource name:
// v1 locations are named "locations/{id}" (bare); v4 reviews need
// "accounts/{accountId}/locations/{locationId}/reviews" — hence building
// `parent` from googleAccountId + locationId rather than reusing either
// stored field alone.
// =============================================================================

const reviewsUrl = (parent: string) => `https://mybusiness.googleapis.com/v4/${parent}/reviews`;

function getMinSyncIntervalMs(): number {
  const minutes = Number(process.env.GOOGLE_REVIEWS_SYNC_MIN_INTERVAL_MINUTES ?? '60');
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
}

const STAR_RATING_MAP: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

function mapStarRating(raw: string | undefined): number {
  return STAR_RATING_MAP[raw ?? ''] ?? 0;
}

/** Has enough time passed since the last sync to run another one? Both
 *  the manual-sync route and the cron sweep call this so the interval
 *  (GOOGLE_REVIEWS_SYNC_MIN_INTERVAL_MINUTES, the WP-20 quota respect
 *  AC) is enforced in exactly one place. */
export function isSyncDue(lastSyncAt: Date | null): boolean {
  if (!lastSyncAt) return true;
  return Date.now() - lastSyncAt.getTime() >= getMinSyncIntervalMs();
}

export interface SyncResult {
  synced: boolean;
  reason?: 'not_active' | 'too_recent' | 'no_access_token' | 'api_error';
  reviewCount?: number;
}

interface GoogleReviewApiEntry {
  name?: string;
  reviewer?: { displayName?: string };
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
}

/**
 * Fetches every review for one connection's location and upserts into
 * GoogleReview, idempotent by googleReviewId (the review's full resource
 * name). Never throws — every failure is recorded on the connection row
 * (`lastSyncError`) and returned as a `SyncResult` instead, so a caller
 * sweeping many connections (the cron route) never needs its own
 * try/catch per connection to stay resilient. Deliberately does NOT
 * retry internally on failure — one bad run just waits for the next
 * scheduled/manual trigger, rather than looping immediately against a
 * service that just failed.
 */
export async function syncReviewsForConnection(
  connection: GoogleBusinessConnection,
  opts: { force?: boolean } = {},
): Promise<SyncResult> {
  if (connection.status !== 'active') {
    return { synced: false, reason: 'not_active' };
  }
  if (!opts.force && !isSyncDue(connection.lastSyncAt)) {
    return { synced: false, reason: 'too_recent' };
  }

  const accessToken = await getValidAccessToken(connection);
  if (!accessToken) {
    // getValidAccessToken already flips status → needs_reconnect on
    // invalid_grant (WP-21) — nothing more to record here for that case;
    // any other transient failure already logged inside it too.
    return { synced: false, reason: 'no_access_token' };
  }

  const parent = `${connection.googleAccountId}/${connection.locationId}`;
  let pageToken: string | undefined;
  let reviewCount = 0;

  try {
    do {
      const url = new URL(reviewsUrl(parent));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const res = await fetch(url.toString(), { headers: { authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        throw new Error(`reviews.list failed with HTTP ${res.status}`);
      }
      const json = (await res.json()) as { reviews?: GoogleReviewApiEntry[]; nextPageToken?: string };

      for (const review of json.reviews ?? []) {
        if (!review.name || !review.createTime || !review.updateTime) continue;
        await prisma.googleReview.upsert({
          where: { googleReviewId: review.name },
          create: {
            connectionId: connection.id,
            clientId: connection.clientId,
            tenantId: connection.tenantId,
            googleReviewId: review.name,
            reviewerName: review.reviewer?.displayName ?? null,
            starRating: mapStarRating(review.starRating),
            comment: review.comment ?? null,
            createTime: new Date(review.createTime),
            updateTime: new Date(review.updateTime),
            replyComment: review.reviewReply?.comment ?? null,
            replyUpdatedAt: review.reviewReply?.updateTime ? new Date(review.reviewReply.updateTime) : null,
          },
          update: {
            reviewerName: review.reviewer?.displayName ?? null,
            starRating: mapStarRating(review.starRating),
            comment: review.comment ?? null,
            updateTime: new Date(review.updateTime),
            replyComment: review.reviewReply?.comment ?? null,
            replyUpdatedAt: review.reviewReply?.updateTime ? new Date(review.reviewReply.updateTime) : null,
            syncedAt: new Date(),
          },
        });
        reviewCount += 1;
      }
      pageToken = json.nextPageToken;
    } while (pageToken);

    await prisma.googleBusinessConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt: new Date(), lastSyncError: null },
    });
    return { synced: true, reviewCount };
  } catch (err) {
    logError('google_review_sync.sync_failed', err, {
      route: 'lib/google-review-sync.ts',
      connectionId: connection.id,
      clientId: connection.clientId,
    });
    await prisma.googleBusinessConnection
      .update({
        where: { id: connection.id },
        data: {
          lastSyncAt: new Date(),
          lastSyncError: err instanceof Error ? err.message.slice(0, 500) : 'unknown_error',
        },
      })
      .catch(() => null);
    return { synced: false, reason: 'api_error' };
  }
}

/**
 * Sweeps every active connection whose sync is due. Used by the cron
 * route (GET /api/cron/sync-google-reviews). Errors are isolated per
 * connection inside syncReviewsForConnection — one bad connection never
 * aborts the sweep for the rest.
 */
export async function syncAllDueConnections(): Promise<{ swept: number; synced: number }> {
  const connections = await prisma.googleBusinessConnection.findMany({ where: { status: 'active' } });
  let synced = 0;
  for (const connection of connections) {
    if (!isSyncDue(connection.lastSyncAt)) continue;
    const result = await syncReviewsForConnection(connection);
    if (result.synced) synced += 1;
  }
  return { swept: connections.length, synced };
}
