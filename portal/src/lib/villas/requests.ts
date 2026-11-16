import 'server-only';
import { Prisma, type PrismaClient, type Villa, type VillaBookingRequest, type VillaRental } from '@prisma/client';
import { logError } from '@/lib/observability';
import { fromDbDate, rangesOverlap, toDbDate, type IsoDate } from './dates';
import { conflictsFor, isRangeFree, type BusyRange } from './availability';
import { quoteStay, type QuoteError, type StayQuote } from './pricing';
import {
  addHours,
  canTransition,
  checkoutExpiry,
  generateGuestToken,
  generateReference,
  type DeclineReason,
} from './request-rules';
import { auditVilla, loadBusyRanges, ownerNotifyEmail, rentalToday, toPricing, toSeasons } from './rental';
import { syncVillaFeeds, type SafeFetchFn } from './ical-sync';
import {
  buildGuestEmail,
  buildOwnerNewRequestEmail,
  buildOwnerPaidEmail,
  formatDay,
  guestRequestUrl,
  sendVillaEmail,
  type GuestEmailKind,
  type Lang,
  type RenderedEmail,
  type StaySummary,
} from './emails';
import {
  createDepositCheckout,
  expireCheckoutSession,
  hasStripeKey,
  readCheckoutSession,
  stripeForRental,
  type DepositStripe,
} from './stripe-deposit';

// =============================================================================
// Reserva propia para villas — las solicitudes, de principio a fin.
//
// Ciclo y transiciones: request-rules.ts. Cada cambio de estado es un
// updateMany condicionado al estado de origen: si dos llamadas compiten (dos
// clics del dueño, el cron y el huésped volviendo de Stripe), solo una cuenta
// 1 y solo esa manda correos. Los correos van DESPUÉS de guardar y nunca
// lanzan (emails.ts).
//
// La doble reserva se evita en dos sitios:
//   1. Al ACEPTAR: se vuelven a leer los iCal de la villa y, con la fila de la
//      villa bloqueada (SELECT … FOR UPDATE), se comprueba que nada ocupe esas
//      noches. Dos aceptaciones a la vez de solicitudes que se pisan no pueden
//      pasar las dos.
//   2. Al CONFIRMARSE (pago), las pendientes que se solapan se rechazan solas.
// Lo que no se puede evitar desde aquí es una reserva de Airbnb hecha después
// de aceptar y antes de que Airbnb lea nuestro iCal: por eso el dueño confirma
// a mano y el plan lo deja escrito como límite del producto.
// =============================================================================

type RentalForEmails = Pick<
  VillaRental,
  'id' | 'clientId' | 'businessName' | 'ownerEmail' | 'ownerPhone' | 'balanceNote' | 'confirmHours' | 'paymentHours' | 'timeZone'
>;

function asLang(value: string): Lang {
  return value === 'en' ? 'en' : 'es';
}

export function summaryOf(request: VillaBookingRequest, villaName: string, businessName: string): StaySummary {
  const quote = request.quote as unknown as Partial<StayQuote>;
  const checkIn = fromDbDate(request.checkIn);
  const checkOut = fromDbDate(request.checkOut);
  return {
    reference: request.reference,
    villaName,
    businessName,
    checkIn,
    checkOut,
    nights: quote.nights ?? Math.round((request.checkOut.getTime() - request.checkIn.getTime()) / 86_400_000),
    adults: request.adults,
    children: request.children,
    totalCents: request.totalCents,
    vatCents: quote.vatCents ?? 0,
    depositCents: request.depositCents,
    currency: request.currency,
  };
}

async function notify(scope: string, to: string | null, email: RenderedEmail, replyTo: string | null, context: Record<string, unknown>) {
  const result = await sendVillaEmail(to, email, replyTo);
  if (!result.ok) logError(`villas.email.${scope}`, new Error(result.error), context, 'warn');
  return result;
}

async function notifyGuest(
  kind: GuestEmailKind,
  request: VillaBookingRequest,
  villaName: string,
  rental: RentalForEmails,
  db: PrismaClient,
) {
  const email = buildGuestEmail(kind, summaryOf(request, villaName, rental.businessName), {
    lang: asLang(request.lang),
    guestName: request.guestName,
    guestToken: request.guestToken,
    confirmHours: rental.confirmHours,
    paymentDueAt: request.paymentDueAt,
    balanceNote: rental.balanceNote,
    ownerPhone: rental.ownerPhone,
    timeZone: rental.timeZone,
  });
  return notify(`guest_${kind}`, request.guestEmail, email, await ownerNotifyEmail(db, rental), {
    requestId: request.id,
  });
}

// --- Crear (huésped, desde el widget) ----------------------------------------------

export interface CreateRequestInput {
  villaSlug: string;
  checkIn: IsoDate;
  checkOut: IsoDate;
  adults: number;
  children: number;
  guestName: string;
  guestEmail: string;
  guestPhone: string | null;
  message: string | null;
  lang: Lang;
  source: string | null;
}

export type CreateRequestResult =
  | { ok: true; reference: string; guestToken: string; statusUrl: string; quote: StayQuote; duplicate: boolean }
  | { ok: false; error: QuoteError | 'villa_not_found' | 'unavailable'; minNights?: number };

type RentalWithVillas = VillaRental & { villas: Array<Villa & { seasons: Parameters<typeof toSeasons>[0] }> };

export async function createVillaRequest(
  db: PrismaClient,
  rental: RentalWithVillas,
  input: CreateRequestInput,
  now: Date = new Date(),
): Promise<CreateRequestResult> {
  const villa = rental.villas.find((v) => v.slug === input.villaSlug && v.isActive);
  if (!villa) return { ok: false, error: 'villa_not_found' };

  const today = rentalToday(rental, now);
  const quoted = quoteStay(
    toPricing(villa),
    toSeasons(villa.seasons),
    { checkIn: input.checkIn, checkOut: input.checkOut, adults: input.adults, children: input.children },
    { depositPercent: rental.depositPercent, today },
  );
  if (!quoted.ok) return { ok: false, error: quoted.error, minNights: quoted.minNights };
  const quote = quoted.quote;

  const busy = await loadBusyRanges(db, villa.id, { today, now });
  if (!isRangeFree(busy, input.checkIn, input.checkOut)) return { ok: false, error: 'unavailable' };

  // Un doble envío (doble clic, red lenta) no crea dos solicitudes: la misma
  // persona, villa y fechas en las últimas 24 h devuelve la que ya hay.
  const email = input.guestEmail.trim().toLowerCase();
  const existing = await db.villaBookingRequest.findFirst({
    where: {
      villaId: villa.id,
      guestEmail: email,
      checkIn: toDbDate(input.checkIn),
      checkOut: toDbDate(input.checkOut),
      status: 'pending',
      createdAt: { gt: addHours(now, -24) },
    },
    select: { reference: true, guestToken: true },
  });
  if (existing) {
    return { ok: true, reference: existing.reference, guestToken: existing.guestToken, statusUrl: guestRequestUrl(existing.guestToken), quote, duplicate: true };
  }

  let created: VillaBookingRequest | null = null;
  for (let attempt = 0; attempt < 4 && !created; attempt++) {
    try {
      created = await db.villaBookingRequest.create({
        data: {
          reference: generateReference(),
          guestToken: generateGuestToken(),
          rentalId: rental.id,
          villaId: villa.id,
          clientId: rental.clientId,
          tenantId: rental.tenantId,
          checkIn: toDbDate(input.checkIn),
          checkOut: toDbDate(input.checkOut),
          adults: input.adults,
          children: input.children,
          guestName: input.guestName.trim(),
          guestEmail: email,
          guestPhone: input.guestPhone?.trim() || null,
          message: input.message?.trim() || null,
          lang: input.lang,
          consentAt: now,
          quote: quote as unknown as Prisma.InputJsonValue,
          totalCents: quote.totalCents,
          depositCents: quote.depositCents,
          currency: quote.currency,
          status: 'pending',
          expiresAt: addHours(now, rental.confirmHours),
          source: input.source?.slice(0, 40) || null,
        },
      });
    } catch (err) {
      // Choque de referencia (única): se reintenta con otra.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
      throw err;
    }
  }
  if (!created) throw new Error('villa_request_reference_exhausted');

  await auditVilla(db, {
    rentalId: rental.id,
    clientId: rental.clientId,
    entity: 'request',
    entityId: created.id,
    action: 'requested',
    actor: 'guest',
    // Sin nombre, email ni teléfono: están en la solicitud, no hace falta copiarlos.
    metadata: { villaId: villa.id, nights: quote.nights, totalCents: quote.totalCents, source: created.source },
  });

  const summary = summaryOf(created, villa.name, rental.businessName);
  await Promise.all([
    notify(
      'owner_new_request',
      await ownerNotifyEmail(db, rental),
      buildOwnerNewRequestEmail(summary, {
        guestName: created.guestName,
        guestEmail: created.guestEmail,
        guestPhone: created.guestPhone,
        message: created.message,
        expiresAt: created.expiresAt,
        timeZone: rental.timeZone,
      }),
      created.guestEmail,
      { requestId: created.id },
    ),
    notifyGuest('received', created, villa.name, rental, db),
  ]);

  return { ok: true, reference: created.reference, guestToken: created.guestToken, statusUrl: guestRequestUrl(created.guestToken), quote, duplicate: false };
}

// --- Decidir (dueño, desde el panel) -------------------------------------------------

async function loadOwnedRequest(db: PrismaClient, rentalId: string, requestId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return null;
  return db.villaBookingRequest.findFirst({
    where: { id: requestId, rentalId },
    include: { villa: { select: { id: true, name: true } }, rental: true },
  });
}

export type DecisionError =
  | 'not_found'
  | 'invalid_transition'
  | 'expired'
  | 'conflict'
  | 'stripe_not_configured';

export type AcceptResult =
  | { ok: true; paymentDueAt: string; icalSync: { feeds: number; failed: number } }
  | { ok: false; error: DecisionError; conflicts?: Array<Pick<BusyRange, 'start' | 'end' | 'kind' | 'label'>> };

export async function acceptVillaRequest(
  db: PrismaClient,
  params: { rentalId: string; requestId: string; actor: string; now?: Date; fetchFn?: SafeFetchFn },
): Promise<AcceptResult> {
  const now = params.now ?? new Date();
  const request = await loadOwnedRequest(db, params.rentalId, params.requestId);
  if (!request) return { ok: false, error: 'not_found' };
  if (!canTransition(request.status, 'accepted')) return { ok: false, error: 'invalid_transition' };
  if (request.expiresAt <= now) return { ok: false, error: 'expired' };
  // Aceptar manda al huésped a pagar: sin clave de Stripe no podría.
  if (!hasStripeKey(request.rental)) return { ok: false, error: 'stripe_not_configured' };

  const today = rentalToday(request.rental, now);
  // Lo último de Airbnb y Booking, justo antes de decidir. Si una lectura
  // falla se sigue con lo que había (y el panel lo dice): bloquear la
  // aceptación porque Booking tarda en contestar dejaría al dueño sin poder
  // trabajar, y él ya ha mirado sus calendarios.
  const icalSync = await syncVillaFeeds(db, request.villaId, { today, fetchFn: params.fetchFn });

  const checkIn = fromDbDate(request.checkIn);
  const checkOut = fromDbDate(request.checkOut);
  const paymentDueAt = addHours(now, request.rental.paymentHours);

  const outcome = await db.$transaction(async (tx) => {
    // Serializa las aceptaciones de la misma villa.
    await tx.$queryRaw`SELECT id FROM "villa" WHERE id = ${request.villaId}::uuid FOR UPDATE`;
    const busy = await loadBusyRanges(tx, request.villaId, { today, now, excludeRequestId: request.id });
    const conflicts = conflictsFor(busy, checkIn, checkOut);
    if (conflicts.length > 0) return { ok: false as const, conflicts };
    const updated = await tx.villaBookingRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: 'accepted', decidedAt: now, paymentDueAt },
    });
    if (updated.count === 0) return { ok: false as const, conflicts: null };
    await auditVilla(tx, {
      rentalId: request.rentalId,
      clientId: request.clientId,
      entity: 'request',
      entityId: request.id,
      action: 'accepted',
      actor: params.actor,
      metadata: { paymentDueAt: paymentDueAt.toISOString(), icalFeeds: icalSync.feeds, icalFailed: icalSync.failed },
    });
    return { ok: true as const };
  });

  if (!outcome.ok) {
    if (outcome.conflicts === null) return { ok: false, error: 'invalid_transition' };
    return {
      ok: false,
      error: 'conflict',
      conflicts: outcome.conflicts.map((c) => ({ start: c.start, end: c.end, kind: c.kind, label: c.label ?? null })),
    };
  }

  await notifyGuest('accepted', { ...request, status: 'accepted', paymentDueAt }, request.villa.name, request.rental, db);
  return { ok: true, paymentDueAt: paymentDueAt.toISOString(), icalSync };
}

export async function declineVillaRequest(
  db: PrismaClient,
  params: { rentalId: string; requestId: string; reason: DeclineReason; actor: string; now?: Date },
): Promise<{ ok: true } | { ok: false; error: DecisionError }> {
  const now = params.now ?? new Date();
  const request = await loadOwnedRequest(db, params.rentalId, params.requestId);
  if (!request) return { ok: false, error: 'not_found' };
  if (!canTransition(request.status, 'declined')) return { ok: false, error: 'invalid_transition' };
  const updated = await db.villaBookingRequest.updateMany({
    where: { id: request.id, status: 'pending' },
    data: { status: 'declined', decidedAt: now, declineReason: params.reason },
  });
  if (updated.count === 0) return { ok: false, error: 'invalid_transition' };
  await auditVilla(db, {
    rentalId: request.rentalId,
    clientId: request.clientId,
    entity: 'request',
    entityId: request.id,
    action: 'declined',
    actor: params.actor,
    metadata: { reason: params.reason },
  });
  await notifyGuest('declined', request, request.villa.name, request.rental, db);
  return { ok: true };
}

/** Anular una aceptada o confirmada. No reembolsa: eso lo hace el dueño desde
 *  su Stripe (fuera de esta versión, ver el plan). Si había una sesión de pago
 *  abierta, se cierra para que nadie pague algo anulado. */
export async function cancelVillaRequest(
  db: PrismaClient,
  params: { rentalId: string; requestId: string; actor: string; now?: Date; stripe?: DepositStripe | null },
): Promise<{ ok: true; wasPaid: boolean } | { ok: false; error: DecisionError }> {
  const now = params.now ?? new Date();
  const request = await loadOwnedRequest(db, params.rentalId, params.requestId);
  if (!request) return { ok: false, error: 'not_found' };
  if (!canTransition(request.status, 'cancelled')) return { ok: false, error: 'invalid_transition' };

  if (request.status === 'accepted' && request.stripeSessionId) {
    const stripe = params.stripe === undefined ? stripeForRental(request.rental) : params.stripe;
    if (stripe) {
      await expireCheckoutSession(stripe, request.stripeSessionId);
      // Puede que se pagara justo antes: entonces se confirma y se sigue
      // anulando, para que el dueño vea que hubo cobro y lo devuelva.
      const state = await readCheckoutSession(stripe, request.stripeSessionId);
      if (state.state === 'paid') await markRequestPaid(db, request.id, { paymentIntentId: state.paymentIntentId, now, sendEmails: false });
    }
  }

  const fresh = await db.villaBookingRequest.findUnique({ where: { id: request.id }, select: { status: true, paidAt: true } });
  if (!fresh || !canTransition(fresh.status, 'cancelled')) return { ok: false, error: 'invalid_transition' };
  const updated = await db.villaBookingRequest.updateMany({
    where: { id: request.id, status: fresh.status },
    data: { status: 'cancelled', decidedAt: now },
  });
  if (updated.count === 0) return { ok: false, error: 'invalid_transition' };
  await auditVilla(db, {
    rentalId: request.rentalId,
    clientId: request.clientId,
    entity: 'request',
    entityId: request.id,
    action: 'cancelled',
    actor: params.actor,
    metadata: { from: fresh.status, wasPaid: fresh.paidAt !== null },
  });
  await notifyGuest('cancelled', request, request.villa.name, request.rental, db);
  return { ok: true, wasPaid: fresh.paidAt !== null };
}

// --- Pagar (huésped, desde su página) ------------------------------------------------

export function loadRequestByGuestToken(db: PrismaClient, guestToken: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(guestToken)) return Promise.resolve(null);
  return db.villaBookingRequest.findUnique({
    where: { guestToken },
    include: { villa: { select: { id: true, name: true } }, rental: true },
  });
}

export type StartCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; error: 'not_found' | 'not_payable' | 'already_paid' | 'stripe_not_configured' | 'stripe_error' };

export async function startDepositCheckout(
  db: PrismaClient,
  params: { guestToken: string; now?: Date; stripe?: DepositStripe | null },
): Promise<StartCheckoutResult> {
  const now = params.now ?? new Date();
  const request = await loadRequestByGuestToken(db, params.guestToken);
  if (!request) return { ok: false, error: 'not_found' };
  if (request.status === 'confirmed') return { ok: false, error: 'already_paid' };
  if (request.status !== 'accepted' || !request.paymentDueAt || request.paymentDueAt <= now) return { ok: false, error: 'not_payable' };
  const stripe = params.stripe === undefined ? stripeForRental(request.rental) : params.stripe;
  if (!stripe) return { ok: false, error: 'stripe_not_configured' };

  // Si ya hay una sesión, se mira antes de abrir otra: pagada → se confirma;
  // abierta → se reutiliza (no dos cobros posibles a la vez).
  if (request.stripeSessionId) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(request.stripeSessionId);
      if (existing.payment_status === 'paid') {
        const pi = typeof existing.payment_intent === 'string' ? existing.payment_intent : (existing.payment_intent?.id ?? null);
        await markRequestPaid(db, request.id, { paymentIntentId: pi, now });
        return { ok: false, error: 'already_paid' };
      }
      if (existing.status === 'open' && existing.url) return { ok: true, url: existing.url };
    } catch {
      // Sesión ilegible (otra clave, borrada): se abre una nueva.
    }
  }

  const { expiresAt, extendDueTo } = checkoutExpiry(request.paymentDueAt, now);
  const lang = asLang(request.lang);
  const checkIn = fromDbDate(request.checkIn);
  const checkOut = fromDbDate(request.checkOut);
  const base = guestRequestUrl(request.guestToken);
  const created = await createDepositCheckout(stripe, {
    requestId: request.id,
    reference: request.reference,
    guestEmail: request.guestEmail,
    depositCents: request.depositCents,
    currency: request.currency,
    productName: `${lang === 'en' ? 'Deposit' : 'Depósito'} · ${request.villa.name}`,
    description: `${formatDay(checkIn, lang)} – ${formatDay(checkOut, lang)} · ${request.reference}`,
    lang,
    successUrl: `${base}?pago=ok&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}?pago=cancelado`,
    expiresAt,
    attempt: Math.floor(now.getTime() / 10_000),
  });
  if (!created.ok) {
    logError('villas.checkout.create_failed', new Error(created.error), { requestId: request.id }, 'warn');
    return { ok: false, error: 'stripe_error' };
  }
  await db.villaBookingRequest.updateMany({
    where: { id: request.id, status: 'accepted' },
    data: { stripeSessionId: created.sessionId, ...(extendDueTo ? { paymentDueAt: extendDueTo } : {}) },
  });
  await auditVilla(db, {
    rentalId: request.rentalId,
    clientId: request.clientId,
    entity: 'request',
    entityId: request.id,
    action: 'checkout_started',
    actor: 'guest',
    metadata: { sessionId: created.sessionId, depositCents: request.depositCents },
  });
  return { ok: true, url: created.url };
}

/** El huésped vuelve de Stripe: se lee la sesión GUARDADA (el session_id de la
 *  URL solo dispara la comprobación; no se confía en él). */
export async function confirmDepositFromReturn(
  db: PrismaClient,
  params: { guestToken: string; now?: Date; stripe?: DepositStripe | null },
): Promise<'confirmed' | 'pending' | 'not_applicable'> {
  const request = await loadRequestByGuestToken(db, params.guestToken);
  if (!request || !request.stripeSessionId) return 'not_applicable';
  if (request.status === 'confirmed') return 'confirmed';
  if (request.status !== 'accepted') return 'not_applicable';
  const stripe = params.stripe === undefined ? stripeForRental(request.rental) : params.stripe;
  if (!stripe) return 'pending';
  const state = await readCheckoutSession(stripe, request.stripeSessionId);
  if (state.state !== 'paid') return 'pending';
  if (state.requestId && state.requestId !== request.id) {
    logError('villas.checkout.reference_mismatch', new Error('client_reference_id no coincide'), { requestId: request.id }, 'warn');
    return 'pending';
  }
  await markRequestPaid(db, request.id, { paymentIntentId: state.paymentIntentId, now: params.now });
  return 'confirmed';
}

/**
 * Depósito pagado → 'confirmed'. Idempotente (updateMany desde 'accepted'):
 * vuelta de Stripe, cron y anulación pueden llamarla a la vez y solo una manda
 * correos. Las pendientes que se pisan con esta se rechazan solas
 * ('dates_taken') y se avisa a esos huéspedes.
 */
export async function markRequestPaid(
  db: PrismaClient,
  requestId: string,
  opts: { paymentIntentId: string | null; now?: Date; sendEmails?: boolean },
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const updated = await db.villaBookingRequest.updateMany({
    where: { id: requestId, status: 'accepted' },
    data: { status: 'confirmed', paidAt: now, stripePaymentIntentId: opts.paymentIntentId },
  });
  if (updated.count === 0) return false;

  const request = await db.villaBookingRequest.findUnique({
    where: { id: requestId },
    include: { villa: { select: { id: true, name: true } }, rental: true },
  });
  if (!request) return false;
  const checkIn = fromDbDate(request.checkIn);
  const checkOut = fromDbDate(request.checkOut);

  const pending = await db.villaBookingRequest.findMany({
    where: { villaId: request.villaId, status: 'pending', checkIn: { lt: request.checkOut }, checkOut: { gt: request.checkIn } },
  });
  const overlapped = pending.filter((p) => rangesOverlap(fromDbDate(p.checkIn), fromDbDate(p.checkOut), checkIn, checkOut));
  const declined: VillaBookingRequest[] = [];
  for (const p of overlapped) {
    const res = await db.villaBookingRequest.updateMany({
      where: { id: p.id, status: 'pending' },
      data: { status: 'declined', decidedAt: now, declineReason: 'dates_taken' },
    });
    if (res.count === 1) {
      declined.push(p);
      await auditVilla(db, {
        rentalId: p.rentalId,
        clientId: p.clientId,
        entity: 'request',
        entityId: p.id,
        action: 'declined',
        actor: 'system',
        metadata: { reason: 'dates_taken', by: request.id },
      });
    }
  }

  await auditVilla(db, {
    rentalId: request.rentalId,
    clientId: request.clientId,
    entity: 'request',
    entityId: request.id,
    action: 'paid',
    actor: 'guest',
    metadata: { depositCents: request.depositCents, autoDeclined: declined.length },
  });

  if (opts.sendEmails !== false) {
    const summary = summaryOf(request, request.villa.name, request.rental.businessName);
    await Promise.all([
      notifyGuest('confirmed', request, request.villa.name, request.rental, db),
      notify('owner_paid', await ownerNotifyEmail(db, request.rental), buildOwnerPaidEmail(summary, request.guestName), request.guestEmail, {
        requestId: request.id,
      }),
      ...declined.map((p) => notifyGuest('declined', p, request.villa.name, request.rental, db)),
    ]);
  }
  return true;
}

// --- Plazos (cron) ---------------------------------------------------------------------

/** Las pendientes sin respuesta a tiempo caducan. */
export async function expirePendingRequests(db: PrismaClient, now: Date = new Date(), limit = 50): Promise<number> {
  const due = await db.villaBookingRequest.findMany({
    where: { status: 'pending', expiresAt: { lte: now } },
    include: { villa: { select: { name: true } }, rental: true },
    take: limit,
  });
  let count = 0;
  for (const r of due) {
    const res = await db.villaBookingRequest.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'expired' } });
    if (res.count === 0) continue;
    count++;
    await auditVilla(db, { rentalId: r.rentalId, clientId: r.clientId, entity: 'request', entityId: r.id, action: 'expired', actor: 'system', metadata: { stage: 'pending' } });
    await notifyGuest('expired_pending', r, r.villa.name, r.rental, db);
  }
  return count;
}

/** Repasa las aceptadas: las pagadas se confirman (el huésped pudo cerrar la
 *  pestaña antes de volver de Stripe) y las que pasaron el plazo caducan —
 *  cerrando antes su sesión de Stripe, y volviendo a mirarla por si se pagó
 *  en el último segundo—. */
export async function reconcileAcceptedRequests(
  db: PrismaClient,
  now: Date = new Date(),
  opts: { limit?: number; stripeFor?: (rental: VillaRental) => DepositStripe | null } = {},
): Promise<{ confirmed: number; expired: number }> {
  const stripeFor = opts.stripeFor ?? stripeForRental;
  const accepted = await db.villaBookingRequest.findMany({
    where: { status: 'accepted', OR: [{ stripeSessionId: { not: null } }, { paymentDueAt: { lte: now } }] },
    include: { villa: { select: { name: true } }, rental: true },
    orderBy: { paymentDueAt: 'asc' },
    take: opts.limit ?? 50,
  });
  let confirmed = 0;
  let expired = 0;
  for (const r of accepted) {
    const stripe = r.stripeSessionId ? stripeFor(r.rental) : null;
    const overdue = !r.paymentDueAt || r.paymentDueAt <= now;
    if (stripe && r.stripeSessionId) {
      if (overdue) await expireCheckoutSession(stripe, r.stripeSessionId);
      const state = await readCheckoutSession(stripe, r.stripeSessionId);
      if (state.state === 'paid') {
        if (await markRequestPaid(db, r.id, { paymentIntentId: state.paymentIntentId, now })) confirmed++;
        continue;
      }
      // Sin respuesta de Stripe no se caduca: mejor esperar al siguiente pase
      // que soltar unas fechas que quizá están pagadas.
      if (state.state === 'error') continue;
    } else if (r.stripeSessionId && overdue) {
      // Hay sesión pero no hay clave para mirarla (se borró del panel). No se
      // puede saber si se pagó: se deja y se registra para que lo vea alguien.
      logError('villas.reconcile.no_stripe_key', new Error('sesión sin clave para comprobarla'), { requestId: r.id }, 'warn');
      continue;
    }
    if (!overdue) continue;
    const res = await db.villaBookingRequest.updateMany({ where: { id: r.id, status: 'accepted' }, data: { status: 'expired' } });
    if (res.count === 0) continue;
    expired++;
    await auditVilla(db, { rentalId: r.rentalId, clientId: r.clientId, entity: 'request', entityId: r.id, action: 'expired', actor: 'system', metadata: { stage: 'payment' } });
    await notifyGuest('expired_payment', r, r.villa.name, r.rental, db);
  }
  return { confirmed, expired };
}

