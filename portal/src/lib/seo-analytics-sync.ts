import 'server-only';
import type { GoogleAnalyticsConnection } from '@prisma/client';
import { prisma } from './prisma';
import { getValidAccessToken } from './google-analytics';
import { logError } from './observability';

// =============================================================================
// SEO con IA — pulls daily site-wide GA4 performance (users/sessions)
// into SeoAnalyticsMetric, idempotently. Mirrors
// seo-search-console-sync.ts's shape closely (isSyncDue / sync-one /
// sync-all-due, same 24h-default coarse interval — GA4 data updates
// roughly once a day too), for a DIFFERENT connection model and a
// DIFFERENT Google API (Data API's runReport, not Search Console's
// searchAnalytics.query).
//
// Endpoint shape verified against Google's current published docs
// (developers.google.com/analytics/devguides/reporting/data/v1,
// fetched Sep 2026). Two DIFFERENT date formats in play, worth being
// explicit about: the REQUEST's dateRanges use "YYYY-MM-DD" (same as
// Search Console), but the RESPONSE's `date` dimension VALUE comes
// back as "YYYYMMDD" (no dashes) — a GA4-specific quirk, not a typo.
// =============================================================================

const RUN_REPORT_URL = (propertyId: string) => `https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`;

// Same rolling-window reasoning as seo-search-console-sync.ts: GA4 also
// revises recent days as more data lands, so every sync re-pulls this
// whole window and upserts rather than only fetching new days.
const SYNC_WINDOW_DAYS = 30;

function getMinSyncIntervalMs(): number {
  const hours = Number(process.env.SEO_ANALYTICS_SYNC_MIN_INTERVAL_HOURS ?? '24');
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60_000;
}

export function isSyncDue(lastSyncAt: Date | null): boolean {
  if (!lastSyncAt) return true;
  return Date.now() - lastSyncAt.getTime() >= getMinSyncIntervalMs();
}

function formatRequestDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** "20260901" -> Date for 2026-09-01. Never a Date-string-parse of the
 *  raw dimension value directly — "20260901" is not a format `new
 *  Date()` understands on its own. */
function parseGa4DateDimension(value: string): Date | null {
  if (!/^\d{8}$/.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface SyncResult {
  synced: boolean;
  reason?: 'not_active' | 'too_recent' | 'no_access_token' | 'api_error';
  dayCount?: number;
}

interface RunReportRow {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}

/**
 * Fetches the last SYNC_WINDOW_DAYS of site-wide daily users/sessions
 * for one connection and upserts into SeoAnalyticsMetric, keyed by
 * (connectionId, date). Never throws — same contract as
 * syncReviewsForConnection/syncSearchConsoleForConnection.
 */
export async function syncAnalyticsForConnection(
  connection: GoogleAnalyticsConnection,
  opts: { force?: boolean } = {},
): Promise<SyncResult> {
  if (connection.status !== 'active' || !connection.propertyId) {
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
    const res = await fetch(RUN_REPORT_URL(connection.propertyId), {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'activeUsers' }, { name: 'sessions' }],
        dateRanges: [{ startDate: formatRequestDate(startDate), endDate: formatRequestDate(endDate) }],
      }),
    });
    if (!res.ok) {
      throw new Error(`runReport failed with HTTP ${res.status}`);
    }
    const json = (await res.json()) as { rows?: RunReportRow[] };

    let dayCount = 0;
    for (const row of json.rows ?? []) {
      const date = parseGa4DateDimension(row.dimensionValues?.[0]?.value ?? '');
      if (!date) continue;
      const users = Math.round(Number(row.metricValues?.[0]?.value ?? 0));
      const sessions = Math.round(Number(row.metricValues?.[1]?.value ?? 0));

      await prisma.seoAnalyticsMetric.upsert({
        where: { connectionId_date: { connectionId: connection.id, date } },
        create: { connectionId: connection.id, clientId: connection.clientId, date, users, sessions },
        update: { users, sessions, syncedAt: new Date() },
      });
      dayCount += 1;
    }

    await prisma.googleAnalyticsConnection.update({
      where: { id: connection.id },
      data: { lastSyncAt: new Date(), lastSyncError: null },
    });

    return { synced: true, dayCount };
  } catch (err) {
    logError('seo_analytics_sync.sync_failed', err, {
      route: 'lib/seo-analytics-sync.ts',
      connectionId: connection.id,
      clientId: connection.clientId,
    });
    await prisma.googleAnalyticsConnection
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
 * route (GET /api/cron/sync-seo-analytics).
 */
export async function syncAllDueConnections(): Promise<{ swept: number; synced: number }> {
  const connections = await prisma.googleAnalyticsConnection.findMany({ where: { status: 'active' } });
  let synced = 0;
  for (const connection of connections) {
    if (!isSyncDue(connection.lastSyncAt)) continue;
    const result = await syncAnalyticsForConnection(connection);
    if (result.synced) synced += 1;
  }
  return { swept: connections.length, synced };
}
