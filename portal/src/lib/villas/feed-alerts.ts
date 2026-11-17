import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from '@/lib/observability';
import { feedAlertCutoff, feedErrorText, feedNeedsAlert } from './feed-alert-rules';
import { feedHost } from './ical-sync';
import { auditVilla, ownerNotifyEmail } from './rental';
import { buildOwnerFeedFailingEmail, sendVillaEmail } from './emails';

// =============================================================================
// Reserva propia para villas — el aviso al dueño de calendarios que no se leen.
//
// Paso del cron (sweep.ts), justo después de leer los iCal. Reglas en
// feed-alert-rules.ts. Un correo por dueño con todos sus calendarios en racha.
//
// `alertedAt` se marca ANTES de mandar (updateMany condicionado a que siga
// vacío): si dos pases del cron se cruzan, solo uno se queda los calendarios y
// solo ese manda el correo. Si el envío falla, no se reintenta: el panel sigue
// enseñando el error, y un correo perdido no justifica arriesgar duplicados.
// =============================================================================

export async function alertFailingFeeds(db: PrismaClient, now: Date = new Date()): Promise<number> {
  const feeds = await db.villaCalendarFeed.findMany({
    where: {
      lastStatus: 'error',
      alertedAt: null,
      errorSince: { lte: feedAlertCutoff(now) },
      villa: { isActive: true, rental: { clientProduct: { status: 'active' } } },
    },
    select: {
      id: true,
      label: true,
      url: true,
      lastStatus: true,
      lastError: true,
      errorSince: true,
      alertedAt: true,
      villa: {
        select: {
          name: true,
          instantBooking: true,
          rental: { select: { id: true, clientId: true, businessName: true, ownerEmail: true, timeZone: true } },
        },
      },
    },
    take: 200,
  });

  const byRental = new Map<string, typeof feeds>();
  for (const feed of feeds.filter((f) => feedNeedsAlert(f, now))) {
    const list = byRental.get(feed.villa.rental.id) ?? [];
    list.push(feed);
    byRental.set(feed.villa.rental.id, list);
  }

  let sent = 0;
  for (const list of byRental.values()) {
    const rental = list[0].villa.rental;
    const claimed = await db.villaCalendarFeed.updateMany({
      where: { id: { in: list.map((f) => f.id) }, alertedAt: null },
      data: { alertedAt: now },
    });
    if (claimed.count === 0) continue;

    for (const f of list) {
      await auditVilla(db, {
        rentalId: rental.id,
        clientId: rental.clientId,
        entity: 'feed',
        entityId: f.id,
        action: 'failing_alerted',
        actor: 'system',
        // Solo el host: la URL lleva el token del calendario (ver ical-sync.ts).
        metadata: { host: feedHost(f.url), error: f.lastError, since: f.errorSince?.toISOString() ?? null },
      });
    }

    const email = buildOwnerFeedFailingEmail({
      businessName: rental.businessName,
      timeZone: rental.timeZone,
      feeds: list.map((f) => ({
        villaName: f.villa.name,
        label: f.label,
        host: feedHost(f.url),
        reason: feedErrorText(f.lastError),
        since: f.errorSince ?? now,
        instantBooking: f.villa.instantBooking,
      })),
    });
    const result = await sendVillaEmail(await ownerNotifyEmail(db, rental), email);
    if (!result.ok) logError('villas.email.owner_feed_failing', new Error(result.error), { rentalId: rental.id }, 'warn');
    else sent++;
  }
  return sent;
}
