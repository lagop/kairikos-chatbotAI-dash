import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from '@/lib/observability';
import { isFeedDue, syncFeed } from './ical-sync';
import { rentalToday } from './rental';
import { expirePendingRequests, reconcileAcceptedRequests } from './requests';

// =============================================================================
// Reserva propia para villas — el pase del cron (/api/cron/villas-tick).
//
// El scheduler (scripts/scheduler.sh) lo llama cada 5 minutos; la lógica de
// «¿toca ya?» vive aquí (isFeedDue, los plazos de cada solicitud), no en la
// cadencia. Idempotente: llamarlo dos veces seguidas no hace nada la segunda.
//
// Tres cosas, en este orden:
//   1. Leer los iCal que tocan (cada 30 min por calendario), con tope por pase.
//   2. Caducar las pendientes sin respuesta.
//   3. Repasar las aceptadas: confirmar las pagadas, caducar las vencidas.
// =============================================================================

const MAX_FEEDS_PER_TICK = 25;

export interface VillasSweepResult {
  feedsSynced: number;
  feedsFailed: number;
  pendingExpired: number;
  paymentsConfirmed: number;
  paymentsExpired: number;
}

export async function sweepVillas(db: PrismaClient, now: Date = new Date()): Promise<VillasSweepResult> {
  const result: VillasSweepResult = { feedsSynced: 0, feedsFailed: 0, pendingExpired: 0, paymentsConfirmed: 0, paymentsExpired: 0 };

  const feeds = await db.villaCalendarFeed.findMany({
    where: { villa: { isActive: true, rental: { clientProduct: { status: 'active' } } } },
    select: { id: true, villaId: true, url: true, lastSyncedAt: true, villa: { select: { rental: { select: { timeZone: true } } } } },
    orderBy: { lastSyncedAt: { sort: 'asc', nulls: 'first' } },
    take: MAX_FEEDS_PER_TICK * 4,
  });
  for (const feed of feeds.filter((f) => isFeedDue(f, now)).slice(0, MAX_FEEDS_PER_TICK)) {
    try {
      const res = await syncFeed(db, feed, { today: rentalToday(feed.villa.rental, now), now });
      if (res.ok) result.feedsSynced++;
      else result.feedsFailed++;
    } catch (err) {
      result.feedsFailed++;
      logError('villas.sweep.feed', err, { feedId: feed.id }, 'warn');
    }
  }

  try {
    result.pendingExpired = await expirePendingRequests(db, now);
  } catch (err) {
    logError('villas.sweep.expire_pending', err, {}, 'error');
  }
  try {
    const reconciled = await reconcileAcceptedRequests(db, now);
    result.paymentsConfirmed = reconciled.confirmed;
    result.paymentsExpired = reconciled.expired;
  } catch (err) {
    logError('villas.sweep.reconcile', err, {}, 'error');
  }
  return result;
}
