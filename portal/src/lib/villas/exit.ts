import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { logError } from '@/lib/observability';
import { toDbDate } from './dates';
import { announcedGraceEnd, serviceState } from './exit-rules';
import { buildOwnerExitEmail, sendVillaEmail } from './emails';
import { auditVilla, ownerNotifyEmail, rentalToday } from './rental';

// =============================================================================
// Reserva propia para villas — la baja, desde el cron (sweep.ts).
//
// No se engancha al sitio donde se cancela la contratación (operador, impago,
// Stripe…): hay varios y cambian. El cron ve las VillaRental cuya contratación
// está 'cancelled' y:
//   1. Si todavía no se avisó al dueño, le avisa una vez (correo con el plazo,
//      qué quitar de Airbnb y Booking y dónde descargar) y lo apunta.
//   2. Si ya se avisó y el plazo pasó (exit-rules.ts), borra la VillaRental:
//      villas, temporadas, calendarios, bloqueos, solicitudes, clave de Stripe
//      y su auditoría caen en cascada. Queda una fila en la auditoría de la
//      contratación (clientProductAudit), que no se borra, para poder decir
//      cuándo y por qué ya no están.
// Reactivar dentro del plazo (activateVillaRental) deja exitNotifiedAt a null.
// =============================================================================

const MAX_EXITS_PER_TICK = 20;

export interface ExitResult {
  notified: number;
  purged: number;
}

export async function processVillaExits(
  db: PrismaClient,
  now: Date = new Date(),
  opts: { send?: typeof sendVillaEmail } = {},
): Promise<ExitResult> {
  const send = opts.send ?? sendVillaEmail;
  const result: ExitResult = { notified: 0, purged: 0 };
  const rentals = await db.villaRental.findMany({
    where: { clientProduct: { status: 'cancelled' } },
    select: {
      id: true,
      clientId: true,
      tenantId: true,
      businessName: true,
      ownerEmail: true,
      timeZone: true,
      exitNotifiedAt: true,
      clientProductId: true,
      clientProduct: { select: { status: true, cancelledAt: true, changedAt: true, productId: true } },
      villas: { select: { name: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
    },
    orderBy: { exitNotifiedAt: { sort: 'asc', nulls: 'first' } },
    take: MAX_EXITS_PER_TICK,
  });

  for (const r of rentals) {
    try {
      if (!r.exitNotifiedAt) {
        // Primero se apunta y luego se manda: dos pases a la vez no mandan
        // dos correos. Si el envío falla queda en el log de errores; el panel
        // enseña lo mismo que el correo.
        const claimed = await db.villaRental.updateMany({ where: { id: r.id, exitNotifiedAt: null }, data: { exitNotifiedAt: now } });
        if (claimed.count === 0) continue;
        const ends = announcedGraceEnd(r.clientProduct, now);
        const upcomingConfirmed = await db.villaBookingRequest.count({
          where: { rentalId: r.id, status: 'confirmed', checkOut: { gt: toDbDate(rentalToday(r, now)) } },
        });
        await auditVilla(db, {
          rentalId: r.id,
          clientId: r.clientId,
          entity: 'rental',
          entityId: r.id,
          action: 'exit_notified',
          actor: 'system',
          metadata: { graceEndsAt: ends.toISOString(), upcomingConfirmed },
        });
        const email = buildOwnerExitEmail({
          businessName: r.businessName,
          graceEndsAt: ends,
          timeZone: r.timeZone,
          villaNames: r.villas.map((v) => v.name),
          upcomingConfirmed,
        });
        const sent = await send(await ownerNotifyEmail(db, r), email, null);
        if (!sent.ok) logError('villas.exit.notify_email', new Error(sent.error), { rentalId: r.id }, 'error');
        result.notified++;
        continue;
      }

      const exit = serviceState(r.clientProduct, r.exitNotifiedAt, now);
      if (exit.state !== 'closed') continue;
      await db.$transaction(async (tx) => {
        await tx.clientProductAudit.create({
          data: {
            clientProductId: r.clientProductId,
            clientId: r.clientId,
            productId: r.clientProduct.productId,
            tenantId: r.tenantId,
            action: 'villas_data_purged',
            statusBefore: r.clientProduct.status,
            statusAfter: r.clientProduct.status,
            actorId: 'system:villas-exit',
          },
        });
        await tx.villaRental.delete({ where: { id: r.id } });
      });
      result.purged++;
    } catch (err) {
      logError('villas.exit', err, { rentalId: r.id }, 'error');
    }
  }
  return result;
}
