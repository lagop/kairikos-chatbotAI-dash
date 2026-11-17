import 'server-only';
import { safeFetch as defaultSafeFetch, BlockedUrlError } from '@/lib/safe-fetch';
import { addDays, toDbDate, type IsoDate } from './dates';
import { parseIcs } from './ical';
import type { PrismaClient } from '@prisma/client';
import type { Db } from './rental';

// =============================================================================
// Reserva propia para villas — leer los calendarios de Airbnb, Booking…
//
// Cada lectura SUSTITUYE los bloqueos de ese calendario (borrar e insertar en
// una transacción): una reserva cancelada en Airbnb desaparece de su iCal y,
// con ella, de aquí. Si la lectura falla, los bloqueos anteriores se QUEDAN:
// vaciarlos por un fallo de red abriría fechas que siguen ocupadas.
//
// La URL la escribe el cliente, así que sale por safeFetch (comprueba la IP al
// conectar, en cada redirección): ver lib/safe-fetch.ts.
//
// Cuándo se lee: el cron cada FEED_SYNC_INTERVAL_MIN, y además en el momento de
// aceptar una solicitud (requests.ts), que es cuando de verdad importa.
// =============================================================================

export const FEED_SYNC_INTERVAL_MIN = 30;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;

export type SafeFetchFn = (url: string, init?: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number }) => Promise<Response>;

/** Forma de la URL antes de guardarla. La comprobación de verdad (IP al
 *  conectar) la hace safeFetch en cada lectura. Solo https: las plataformas lo
 *  usan todas, y un http en claro dejaría ver el token de la URL. */
export function normalizeFeedUrl(raw: string): string | null {
  const value = raw.trim().replace(/^webcal:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (url.username || url.password) return null;
  return url.toString();
}

/** El host, que es lo único de la URL que va a la auditoría y a los logs. */
export function feedHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'url-invalida';
  }
}

export function isFeedDue(feed: { lastSyncedAt: Date | null }, now: Date = new Date()): boolean {
  if (!feed.lastSyncedAt) return true;
  return now.getTime() - feed.lastSyncedAt.getTime() >= FEED_SYNC_INTERVAL_MIN * 60 * 1000;
}

export type FeedSyncResult = { ok: true; events: number } | { ok: false; error: string };

export async function syncFeed(
  db: PrismaClient,
  feed: { id: string; villaId: string; url: string },
  opts: { today: IsoDate; now?: Date; fetchFn?: SafeFetchFn },
): Promise<FeedSyncResult> {
  const now = opts.now ?? new Date();
  const fetchFn = opts.fetchFn ?? (defaultSafeFetch as SafeFetchFn);
  let text: string;
  try {
    const res = await fetchFn(feed.url, {
      headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1', 'user-agent': 'Kairikos-Villas/1.0 (+https://kairikos.com)' },
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_BYTES,
    });
    if (res.status !== 200) return markError(db, feed.id, `http_${res.status}`, now);
    text = await res.text();
  } catch (err) {
    const error = err instanceof BlockedUrlError ? err.message : err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error';
    return markError(db, feed.id, error, now);
  }
  if (!/BEGIN:VCALENDAR/i.test(text)) return markError(db, feed.id, 'not_ical', now);

  // Lo que ya terminó no ocupa nada: se guarda desde ayer (margen de zona).
  const keepFrom = addDays(opts.today, -1);
  const events = parseIcs(text).filter((e) => e.end > keepFrom);

  await db.$transaction(async (tx) => {
    await tx.villaBlock.deleteMany({ where: { feedId: feed.id } });
    if (events.length > 0) {
      await tx.villaBlock.createMany({
        data: events.map((e) => ({
          villaId: feed.villaId,
          feedId: feed.id,
          startDate: toDbDate(e.start),
          endDate: toDbDate(e.end),
          uid: e.uid?.slice(0, 255) ?? null,
          // El SUMMARY de Airbnb es «Reserved» o «Airbnb (Not available)»; el de
          // Booking, «CLOSED - Not available». No lleva nombres, pero se corta.
          note: e.summary?.slice(0, 120) ?? null,
        })),
      });
    }
    await tx.villaCalendarFeed.update({
      where: { id: feed.id },
      // Una lectura buena corta la racha de fallos: si vuelve a fallar, se
      // avisará otra vez (feed-alerts.ts).
      data: { lastSyncedAt: now, lastStatus: 'ok', lastError: null, eventCount: events.length, errorSince: null, alertedAt: null },
    });
  });
  return { ok: true, events: events.length };
}

async function markError(db: Db, feedId: string, error: string, now: Date): Promise<FeedSyncResult> {
  // El inicio de la racha solo se pone en el primer fallo: así el aviso al
  // dueño sabe cuánto lleva fallando, no cuándo falló la última vez.
  await db.villaCalendarFeed.updateMany({ where: { id: feedId, errorSince: null }, data: { errorSince: now } });
  await db.villaCalendarFeed.update({
    where: { id: feedId },
    data: { lastSyncedAt: now, lastStatus: 'error', lastError: error.slice(0, 200) },
  });
  return { ok: false, error };
}

/** Todas las de una villa, en paralelo. Lo usa la aceptación de una solicitud. */
export async function syncVillaFeeds(
  db: PrismaClient,
  villaId: string,
  opts: { today: IsoDate; fetchFn?: SafeFetchFn },
): Promise<{ feeds: number; failed: number }> {
  const feeds = await db.villaCalendarFeed.findMany({ where: { villaId }, select: { id: true, villaId: true, url: true } });
  const results = await Promise.all(feeds.map((f) => syncFeed(db, f, opts)));
  return { feeds: feeds.length, failed: results.filter((r) => !r.ok).length };
}
