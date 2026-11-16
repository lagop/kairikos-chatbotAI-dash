import 'server-only';
import type { Prisma, PrismaClient, Villa, VillaRental, VillaSeason } from '@prisma/client';
import { fromDbDate, todayIn, toDbDate, type IsoDate } from './dates';
import type { SeasonRule, VillaPricing } from './pricing';
import type { BusyRange } from './availability';
import { generatePublicToken } from './request-rules';
import { serviceState } from './exit-rules';
import { assignSiteToNewContract } from '../client-site';

// =============================================================================
// Reserva propia para villas — acceso a la base de datos compartido.
//
// Lo que leen a la vez las rutas públicas, el panel del dueño, el cron y las
// solicitudes: de fila de Prisma a los tipos puros de pricing/availability, los
// rangos ocupados de una villa y la auditoría. Ver docs/plan-reserva-villas.md.
// =============================================================================

export type Db = PrismaClient | Prisma.TransactionClient;

export const VILLAS_PRODUCT_CODE = 'villas';

export function toPricing(villa: Pick<Villa, 'nightlyCents' | 'minNights' | 'cleaningFeeCents' | 'vatRateBps' | 'touristTaxCents' | 'maxGuests'>): VillaPricing {
  return {
    nightlyCents: villa.nightlyCents,
    minNights: villa.minNights,
    cleaningFeeCents: villa.cleaningFeeCents,
    vatRateBps: villa.vatRateBps,
    touristTaxCents: villa.touristTaxCents,
    maxGuests: villa.maxGuests,
  };
}

export function toSeasons(rows: readonly Pick<VillaSeason, 'name' | 'startDate' | 'endDate' | 'nightlyCents' | 'minNights'>[]): SeasonRule[] {
  return rows.map((s) => ({
    name: s.name,
    startDate: fromDbDate(s.startDate),
    endDate: fromDbDate(s.endDate),
    nightlyCents: s.nightlyCents,
    minNights: s.minNights,
  }));
}

export function rentalToday(rental: Pick<VillaRental, 'timeZone'>, now: Date = new Date()): IsoDate {
  try {
    return todayIn(rental.timeZone, now);
  } catch {
    // Una zona mal escrita no puede tumbar el calendario.
    return todayIn('Europe/Madrid', now);
  }
}

/** Las noches ocupadas de una villa desde `today`: bloqueos (iCal y manuales)
 *  y solicitudes aceptadas dentro de plazo o confirmadas. `excludeRequestId`
 *  deja fuera la propia solicitud cuando se comprueba si se puede aceptar. */
export async function loadBusyRanges(
  db: Db,
  villaId: string,
  opts: { today: IsoDate; now?: Date; excludeRequestId?: string },
): Promise<BusyRange[]> {
  const now = opts.now ?? new Date();
  const from = toDbDate(opts.today);
  const [blocks, requests] = await Promise.all([
    db.villaBlock.findMany({
      where: { villaId, endDate: { gt: from } },
      select: { id: true, startDate: true, endDate: true, feedId: true, note: true, feed: { select: { label: true } } },
    }),
    db.villaBookingRequest.findMany({
      where: {
        villaId,
        checkOut: { gt: from },
        ...(opts.excludeRequestId ? { id: { not: opts.excludeRequestId } } : {}),
        OR: [{ status: 'confirmed' }, { status: 'accepted', paymentDueAt: { gt: now } }],
      },
      select: { id: true, checkIn: true, checkOut: true, reference: true },
    }),
  ]);
  return [
    ...blocks.map((b) => ({
      start: fromDbDate(b.startDate),
      end: fromDbDate(b.endDate),
      kind: b.feedId ? ('ical' as const) : ('manual' as const),
      id: b.id,
      label: b.feedId ? (b.feed?.label ?? 'iCal') : b.note,
    })),
    ...requests.map((r) => ({
      start: fromDbDate(r.checkIn),
      end: fromDbDate(r.checkOut),
      kind: 'request' as const,
      id: r.id,
      label: r.reference,
    })),
  ];
}

export interface AuditInput {
  rentalId: string;
  clientId: string;
  entity: 'rental' | 'villa' | 'feed' | 'block' | 'request';
  entityId: string;
  action: string;
  /** 'client:<id>' | 'operator:<id>' | 'guest' | 'system' */
  actor: string;
  metadata?: Prisma.InputJsonValue;
}

export async function auditVilla(db: Db, input: AuditInput): Promise<void> {
  await db.villaRentalAudit.create({
    data: {
      rentalId: input.rentalId,
      clientId: input.clientId,
      entity: input.entity,
      entityId: input.entityId,
      action: input.action,
      actor: input.actor,
      metadata: input.metadata ?? {},
    },
  });
}

/** La configuración de una web por su token público, solo si la contratación
 *  está activa: un cliente dado de baja deja de recibir solicitudes aunque el
 *  widget siga pegado en su web. */
export async function findRentalByPublicToken(db: Db, token: string) {
  if (!/^vil_[A-Za-z0-9_-]{10,60}$/.test(token)) return null;
  return db.villaRental.findFirst({
    where: { publicToken: token, clientProduct: { status: 'active' } },
    include: {
      villas: {
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { seasons: { orderBy: { startDate: 'asc' } } },
      },
    },
  });
}

/** La configuración del cliente de la sesión. Una contratación por cliente
 *  (no es multi-instancia), así que no hace falta elegir. Pausada también se
 *  ve: el dueño tiene que poder leer sus solicitudes aunque no entren nuevas. */
export async function findRentalForClient(db: Db, clientId: string) {
  return db.villaRental.findFirst({
    where: { clientId, clientProduct: { status: { in: ['active', 'paused'] }, product: { code: VILLAS_PRODUCT_CODE } } },
  });
}

/**
 * La VillaRental del cliente para LEER y EXPORTAR, también dada de baja dentro
 * del plazo de gracia (exit-rules.ts). Las rutas que escriben siguen usando
 * findRentalForClient: durante la baja el panel es de solo lectura.
 */
export async function findRentalForOwner(db: Db, clientId: string, now: Date = new Date()) {
  const rental = await db.villaRental.findFirst({
    where: { clientId, clientProduct: { product: { code: VILLAS_PRODUCT_CODE } } },
    include: { clientProduct: { select: { status: true, cancelledAt: true, changedAt: true } } },
  });
  if (!rental) return null;
  const exit = serviceState(rental.clientProduct, rental.exitNotifiedAt, now);
  if (exit.state === 'closed') return null;
  return { rental, ...exit };
}

export type ActivateResult =
  | { ok: true; rentalId: string; clientProductId: string; created: boolean }
  | { ok: false; error: 'client_not_found' | 'product_missing' };

/**
 * Alta del módulo por el operador (no hay autoservicio: se vende dentro de un
 * presupuesto de Signature). Idempotente: si ya existe, la devuelve; si había
 * una contratación cancelada, la reactiva con UPDATE —el índice parcial único
 * de ClientProduct no deja otra fila para el mismo producto—.
 */
export async function activateVillaRental(
  db: Prisma.TransactionClient,
  input: { clientId: string; operatorId: string },
): Promise<ActivateResult> {
  const [client, product] = await Promise.all([
    db.chatbotClient.findUnique({ where: { id: input.clientId }, select: { id: true, tenantId: true, companyName: true, name: true } }),
    db.product.findFirst({ where: { code: VILLAS_PRODUCT_CODE, isActive: true }, select: { id: true } }),
  ]);
  if (!client) return { ok: false, error: 'client_not_found' };
  if (!product) return { ok: false, error: 'product_missing' };

  const actorId = `operator:${input.operatorId}`;
  let contract = await db.clientProduct.findFirst({
    where: { clientId: client.id, productId: product.id },
    select: { id: true, status: true },
  });
  if (!contract) {
    contract = await db.clientProduct.create({
      data: { clientId: client.id, productId: product.id, tenantId: client.tenantId, status: 'active', createdBy: actorId, onboardingState: 'live' },
      select: { id: true, status: true },
    });
    await db.clientProductAudit.create({
      data: { clientProductId: contract.id, clientId: client.id, productId: product.id, tenantId: client.tenantId, action: 'villas_activated', statusBefore: null, statusAfter: 'active', actorId },
    });
  } else if (contract.status !== 'active') {
    await db.clientProduct.update({ where: { id: contract.id }, data: { status: 'active', cancelledAt: null, changedBy: actorId, changedAt: new Date() } });
    await db.clientProductAudit.create({
      data: { clientProductId: contract.id, clientId: client.id, productId: product.id, tenantId: client.tenantId, action: 'villas_reactivated', statusBefore: contract.status, statusAfter: 'active', actorId },
    });
  }

  // El negocio al que pertenece la contratación, como en cualquier alta de
  // operador (lib/client-product-activation.ts). Idempotente.
  await assignSiteToNewContract(db, { clientId: client.id, tenantId: client.tenantId, clientProductId: contract.id, productCode: VILLAS_PRODUCT_CODE });

  const r = await ensureVillaRentalForContract(db, {
    clientProductId: contract.id,
    clientId: client.id,
    tenantId: client.tenantId,
    businessName: client.companyName ?? client.name,
    actorId,
  });
  return { ok: true, rentalId: r.rentalId, clientProductId: contract.id, created: r.created };
}

/**
 * La VillaRental de una contratación 'villas' ya activa: la crea vacía, con el
 * token del widget, si no existe; si existe y estaba en el plazo de gracia de
 * una baja, anula la baja. La usan las dos altas de operador: la de
 * POST /api/admin/portal/villas y la del panel «Productos contratados»
 * (activateClientProductForOperator), para que activar o reactivar por
 * cualquiera de las dos deje el módulo igual.
 */
export async function ensureVillaRentalForContract(
  db: Prisma.TransactionClient,
  input: { clientProductId: string; clientId: string; tenantId: string | null; businessName: string; actorId: string },
): Promise<{ rentalId: string; created: boolean }> {
  const existing = await db.villaRental.findUnique({ where: { clientProductId: input.clientProductId }, select: { id: true, exitNotifiedAt: true } });
  if (existing) {
    // Vuelve dentro del plazo de gracia: la baja queda anulada y, si algún
    // día se da de baja otra vez, el aviso tiene que salir de nuevo.
    if (existing.exitNotifiedAt) await db.villaRental.update({ where: { id: existing.id }, data: { exitNotifiedAt: null } });
    return { rentalId: existing.id, created: false };
  }

  const rental = await db.villaRental.create({
    data: {
      clientProductId: input.clientProductId,
      clientId: input.clientId,
      tenantId: input.tenantId,
      publicToken: generatePublicToken('vil'),
      businessName: input.businessName,
    },
    select: { id: true },
  });
  await auditVilla(db, { rentalId: rental.id, clientId: input.clientId, entity: 'rental', entityId: rental.id, action: 'created', actor: input.actorId });
  return { rentalId: rental.id, created: true };
}

/** El correo al que van los avisos del dueño: el suyo propio si lo puso, y si
 *  no, el de la cuenta. */
export async function ownerNotifyEmail(db: Db, rental: Pick<VillaRental, 'ownerEmail' | 'clientId'>): Promise<string | null> {
  if (rental.ownerEmail && rental.ownerEmail.includes('@')) return rental.ownerEmail;
  const client = await db.chatbotClient.findUnique({ where: { id: rental.clientId }, select: { email: true } });
  return client?.email ?? null;
}
