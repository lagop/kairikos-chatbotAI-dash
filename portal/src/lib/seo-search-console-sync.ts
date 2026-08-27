import 'server-only';
import type { GoogleSeoConnection } from '@prisma/client';
import { prisma } from './prisma';
import { getValidAccessToken } from './google-search-console';
import { logError } from './observability';

// =============================================================================
// SEO con IA, Fase B — pulls daily site-wide performance
// (clicks/impressions/ctr/position) from Search Console into
// SeoSearchConsoleMetric, idempotently. Mirrors google-review-sync.ts's
// shape closely (isSyncDue / sync-one / sync-all-due), but the interval
// is much coarser — Search Console data updates roughly once a day with
// a documented ~2-3 day processing lag, so polling every few minutes
// (like reviews) would just repeat identical work.
//
// Endpoint shape (searchAnalytics.query) verified against Google's
// current published docs (developers.google.com/webmaster-tools/v1/
// searchanalytics/query, fetched Sep 2026).
// =============================================================================

const QUERY_URL = (siteUrl: string) =>
  `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

// How many trailing days to (re-)fetch on every sync. Search Console
// revises recent days as more data lands, so a sync always re-pulls
// this whole window and upserts, rather than only fetching days newer
// than lastSyncAt.
const SYNC_WINDOW_DAYS = 30;

function getMinSyncIntervalMs(): number {
  const hours = Number(process.env.SEO_SEARCH_CONSOLE_SYNC_MIN_INTERVAL_HOURS ?? '24');
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60_000;
}

/** Same one-place-enforces-the-interval reasoning as
 *  google-review-sync.ts's isSyncDue — both the cron sweep and any
 *  future manual-sync route call this. */
export function isSyncDue(lastSyncAt: Date | null): boolean {
  if (!lastSyncAt) return true;
  return Date.now() - lastSyncAt.getTime() >= getMinSyncIntervalMs();
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface SyncResult {
  synced: boolean;
  reason?: 'not_active' | 'too_recent' | 'no_access_token' | 'api_error';
  dayCount?: number;
}

interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

/**
 * Fetches the last SYNC_WINDOW_DAYS of site-wide daily metrics for one
 * connection and upserts into SeoSearchConsoleMetric, keyed by
 * (connectionId, date). Never throws — every failure is recorded on the
 * connection row (`lastSyncError`) and returned as a `SyncResult`,
 * matching syncReviewsForConnection's contract so the cron route needs
 * no per-connection try/catch of its own.
 */
export async function syncSearchConsoleForConnection(
  connection: GoogleSeoConnection,
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
    return { synced: false, reason: 'no_access_token' };
  }

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - SYNC_WINDOW_DAYS * 24 * 60 * 60_000);

  try {
    const res = await fetch(QUERY_URL(connection.searchConsoleSiteUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        startDate: formatDate(startDate),
        endDate: formatDate(endDate),
        dimensions: ['date'],
        aggregationType: 'byProperty',
        rowLimit: SYNC_WINDOW_DAYS + 1,
      }),
    });
    if (!res.ok) {
      throw new Error(`searchAnalytics.query failed with HTTP ${res.status}`);
    }
    const json = (await res.json()) as { rows?: SearchAnalyticsRow[] };

    let dayCount = 0;
    for (const row of json.rows ?? []) {
      const dateKey = row.keys?.[0];
      if (!dateKey) continue;
      await prisma.seoSearchConsoleMetric.upsert({
        where: { connectionId_date: { connectionId: connection.id, date: new Date(dateKey) } },
        create: {
          connectionId: connection.id,
          clientId: connection.clientId,
          date: new Date(dateKey),
          clicks: Math.round(row.clicks ?? 0),
          impressions: Math.round(row.impressions ?? 0),
          ctr: row.ctr ?? 0,
          position: row.position ?? 0,
        },
        update: {
          clicks: Math.round(row.clicks ?? 0),
          impressions: Math.round(row.impressions ?? 0),
          ctr: row.ctr ?? 0,
          position: row.position ?? 0,
          syncedAt: new Date(),
        },
      });
      dayCount += 1;
    }

    await prisma.googleSeoConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt: new Date(), lastSyncError: null },
    });

    return { synced: true, dayCount };
  } catch (err) {
    logError('seo_search_console_sync.sync_failed', err, {
      route: 'lib/seo-search-console-sync.ts',
      connectionId: connection.id,
      clientId: connection.clientId,
    });
    await prisma.googleSeoConnection
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
 * route (GET /api/cron/sync-seo-search-console). Errors are isolated
 * per connection inside syncSearchConsoleForConnection — one bad
 * connection never aborts the sweep for the rest.
 */
export async function syncAllDueConnections(): Promise<{ swept: number; synced: number }> {
  const connections = await prisma.googleSeoConnection.findMany({ where: { status: 'active' } });
  let synced = 0;
  for (const connection of connections) {
    if (!isSyncDue(connection.lastSyncAt)) continue;
    const result = await syncSearchConsoleForConnection(connection);
    if (result.synced) synced += 1;
  }
  return { swept: connections.length, synced };
}
