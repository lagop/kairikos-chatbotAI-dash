// Reserva propia para villas — el ciclo de una solicitud contra un Prisma
// simulado (lib/villas/requests.ts): aceptar sin pisar otra reserva, confirmar
// al pagar rechazando las pendientes que se solapan, y el repaso del cron.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendVillaEmail = vi.fn();
vi.mock('@/lib/villas/emails', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/villas/emails')>();
  return { ...original, sendVillaEmail: (...args: unknown[]) => sendVillaEmail(...args) };
});
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { acceptVillaRequest, markRequestPaid, reconcileAcceptedRequests } from '@/lib/villas/requests';
import type { DepositStripe } from '@/lib/villas/stripe-deposit';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date('2026-11-15T12:00:00Z');
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

const rental = {
  id: 'rental-1',
  clientId: 'client-1',
  businessName: 'Villas Sombra Buena',
  ownerEmail: 'dueno@villas.example',
  ownerPhone: null,
  balanceNote: null,
  confirmHours: 24,
  paymentHours: 48,
  timeZone: 'Europe/Madrid',
  stripeKeyCiphertext: 'x',
  stripeKeyIv: 'y',
  stripeKeyTag: 'z',
};

function requestRow(over: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    rentalId: 'rental-1',
    clientId: 'client-1',
    villaId: 'villa-1',
    reference: 'VR-ABC234',
    guestToken: 'g'.repeat(32),
    checkIn: day('2026-12-14'),
    checkOut: day('2026-12-21'),
    adults: 2,
    children: 0,
    guestName: 'Ana López',
    guestEmail: 'ana@correo.example',
    guestPhone: null,
    message: null,
    lang: 'es',
    quote: {},
    totalCents: 132_000,
    depositCents: 39_600,
    currency: 'EUR',
    status: 'pending',
    expiresAt: new Date('2026-11-16T12:00:00Z'),
    decidedAt: null,
    declineReason: null,
    paymentDueAt: null,
    stripeSessionId: null,
    stripePaymentIntentId: null,
    paidAt: null,
    villa: { id: 'villa-1', name: 'Villa Alcornoque' },
    rental,
    ...over,
  };
}

function fakeDb() {
  const db = {
    villaBookingRequest: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    villaBlock: { findMany: vi.fn().mockResolvedValue([]) },
    villaCalendarFeed: { findMany: vi.fn().mockResolvedValue([]) },
    villaRentalAudit: { create: vi.fn().mockResolvedValue({}) },
    chatbotClient: { findUnique: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  return db;
}

beforeEach(() => {
  sendVillaEmail.mockReset().mockResolvedValue({ ok: true });
});

describe('aceptar', () => {
  it('con las noches libres pasa a «aceptada», fija el plazo de pago y avisa al huésped', async () => {
    const db = fakeDb();
    db.villaBookingRequest.findFirst.mockResolvedValue(requestRow());
    const res = await acceptVillaRequest(db as never, { rentalId: 'rental-1', requestId: REQUEST_ID, actor: 'client:client-1', now: NOW });
    expect(res).toEqual({ ok: true, paymentDueAt: '2026-11-17T12:00:00.000Z', icalSync: { feeds: 0, failed: 0 } });
    expect(db.$queryRaw).toHaveBeenCalledOnce(); // la villa bloqueada mientras se comprueba
    expect(db.villaBookingRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, status: 'pending' },
      data: { status: 'accepted', decidedAt: NOW, paymentDueAt: new Date('2026-11-17T12:00:00Z') },
    });
    expect(db.villaRentalAudit.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'accepted', actor: 'client:client-1' }) });
    expect(sendVillaEmail).toHaveBeenCalledOnce();
    expect(sendVillaEmail.mock.calls[0][0]).toBe('ana@correo.example');
  });

  it('si Airbnb ya tiene esas noches, no acepta y dice con qué choca', async () => {
    const db = fakeDb();
    db.villaBookingRequest.findFirst.mockResolvedValue(requestRow());
    db.villaBlock.findMany.mockResolvedValue([
      { id: 'b1', startDate: day('2026-12-18'), endDate: day('2026-12-20'), feedId: 'f1', note: null, feed: { label: 'Airbnb' } },
    ]);
    const res = await acceptVillaRequest(db as never, { rentalId: 'rental-1', requestId: REQUEST_ID, actor: 'client:client-1', now: NOW });
    expect(res).toEqual({ ok: false, error: 'conflict', conflicts: [{ start: '2026-12-18', end: '2026-12-20', kind: 'ical', label: 'Airbnb' }] });
    expect(db.villaBookingRequest.updateMany).not.toHaveBeenCalled();
    expect(sendVillaEmail).not.toHaveBeenCalled();
  });

  it('sin clave de Stripe no se acepta: el huésped no podría pagar', async () => {
    const db = fakeDb();
    db.villaBookingRequest.findFirst.mockResolvedValue(requestRow({ rental: { ...rental, stripeKeyCiphertext: null } }));
    const res = await acceptVillaRequest(db as never, { rentalId: 'rental-1', requestId: REQUEST_ID, actor: 'client:client-1', now: NOW });
    expect(res).toEqual({ ok: false, error: 'stripe_not_configured' });
  });

  it('una pendiente caducada o ya decidida no se acepta', async () => {
    const db = fakeDb();
    db.villaBookingRequest.findFirst.mockResolvedValueOnce(requestRow({ expiresAt: new Date('2026-11-15T11:00:00Z') }));
    expect(await acceptVillaRequest(db as never, { rentalId: 'rental-1', requestId: REQUEST_ID, actor: 'a', now: NOW })).toEqual({ ok: false, error: 'expired' });
    db.villaBookingRequest.findFirst.mockResolvedValueOnce(requestRow({ status: 'declined' }));
    expect(await acceptVillaRequest(db as never, { rentalId: 'rental-1', requestId: REQUEST_ID, actor: 'a', now: NOW })).toEqual({ ok: false, error: 'invalid_transition' });
  });

  it('dos clics a la vez: el segundo no manda otro correo', async () => {
    const db = fakeDb();
    db.villaBookingRequest.findFirst.mockResolvedValue(requestRow());
    db.villaBookingRequest.updateMany.mockResolvedValue({ count: 0 });
    const res = await acceptVillaRequest(db as never, { rentalId: 'rental-1', requestId: REQUEST_ID, actor: 'a', now: NOW });
    expect(res).toEqual({ ok: false, error: 'invalid_transition' });
    expect(sendVillaEmail).not.toHaveBeenCalled();
  });

  it('un id que no es uuid ni se busca', async () => {
    const db = fakeDb();
    expect(await acceptVillaRequest(db as never, { rentalId: 'rental-1', requestId: "1' OR 1=1", actor: 'a', now: NOW })).toEqual({ ok: false, error: 'not_found' });
    expect(db.villaBookingRequest.findFirst).not.toHaveBeenCalled();
  });
});

describe('pago del depósito', () => {
  it('confirma, rechaza solas las pendientes que se solapan y avisa a todos', async () => {
    const db = fakeDb();
    db.villaBookingRequest.findUnique.mockResolvedValue(requestRow({ status: 'confirmed', paymentDueAt: new Date('2026-11-17T12:00:00Z') }));
    const overlapping = requestRow({ id: 'req-2', reference: 'VR-OTRA22', guestEmail: 'luis@correo.example', checkIn: day('2026-12-20'), checkOut: day('2026-12-23') });
    const touching = requestRow({ id: 'req-3', reference: 'VR-OTRA33', guestEmail: 'eva@correo.example', checkIn: day('2026-12-21'), checkOut: day('2026-12-24') });
    db.villaBookingRequest.findMany.mockResolvedValue([overlapping, touching]);

    expect(await markRequestPaid(db as never, REQUEST_ID, { paymentIntentId: 'pi_1', now: NOW })).toBe(true);

    expect(db.villaBookingRequest.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: REQUEST_ID, status: 'accepted' },
      data: { status: 'confirmed', paidAt: NOW, stripePaymentIntentId: 'pi_1' },
    });
    // Solo la que se pisa: la que entra el día de la salida sigue pendiente.
    expect(db.villaBookingRequest.updateMany).toHaveBeenCalledTimes(2);
    expect(db.villaBookingRequest.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'req-2', status: 'pending' },
      data: { status: 'declined', decidedAt: NOW, declineReason: 'dates_taken' },
    });
    const recipients = sendVillaEmail.mock.calls.map((c) => c[0]).sort();
    expect(recipients).toEqual(['ana@correo.example', 'dueno@villas.example', 'luis@correo.example']);
  });

  it('si ya estaba confirmada no hace nada más', async () => {
    const db = fakeDb();
    db.villaBookingRequest.updateMany.mockResolvedValue({ count: 0 });
    expect(await markRequestPaid(db as never, REQUEST_ID, { paymentIntentId: 'pi_1', now: NOW })).toBe(false);
    expect(db.villaBookingRequest.findUnique).not.toHaveBeenCalled();
    expect(sendVillaEmail).not.toHaveBeenCalled();
  });
});

function stripeWith(state: Record<string, unknown> | Error) {
  const sessions = {
    retrieve: state instanceof Error ? vi.fn().mockRejectedValue(state) : vi.fn().mockResolvedValue({ id: 'cs_1', ...state }),
    expire: vi.fn().mockResolvedValue({}),
    create: vi.fn(),
    list: vi.fn(),
  };
  return { stripe: { checkout: { sessions } } as unknown as DepositStripe, sessions };
}

describe('repaso del cron', () => {
  const accepted = (over: Record<string, unknown> = {}) =>
    requestRow({ status: 'accepted', stripeSessionId: 'cs_1', paymentDueAt: new Date('2026-11-16T12:00:00Z'), ...over });

  it('confirma la pagada aunque el huésped cerrara la pestaña antes de volver', async () => {
    const db = fakeDb();
    db.villaBookingRequest.findMany.mockResolvedValueOnce([accepted()]).mockResolvedValue([]);
    db.villaBookingRequest.findUnique.mockResolvedValue(accepted({ status: 'confirmed' }));
    const { stripe } = stripeWith({ status: 'complete', payment_status: 'paid', payment_intent: 'pi_9', amount_total: 39_600, client_reference_id: REQUEST_ID });
    expect(await reconcileAcceptedRequests(db as never, NOW, { stripeFor: () => stripe })).toEqual({ confirmed: 1, expired: 0 });
  });

  it('fuera de plazo: cierra la sesión de Stripe y caduca la solicitud', async () => {
    const db = fakeDb();
    db.villaBookingRequest.findMany.mockResolvedValueOnce([accepted({ paymentDueAt: new Date('2026-11-15T11:00:00Z') })]);
    const { stripe, sessions } = stripeWith({ status: 'expired', payment_status: 'unpaid' });
    expect(await reconcileAcceptedRequests(db as never, NOW, { stripeFor: () => stripe })).toEqual({ confirmed: 0, expired: 1 });
    expect(sessions.expire).toHaveBeenCalledWith('cs_1');
    expect(db.villaBookingRequest.updateMany).toHaveBeenCalledWith({ where: { id: REQUEST_ID, status: 'accepted' }, data: { status: 'expired' } });
    expect(sendVillaEmail).toHaveBeenCalledOnce();
  });

  it('si Stripe no contesta, no suelta unas fechas que quizá están pagadas', async () => {
    const db = fakeDb();
    db.villaBookingRequest.findMany.mockResolvedValueOnce([accepted({ paymentDueAt: new Date('2026-11-15T11:00:00Z') })]);
    const { stripe } = stripeWith(new Error('timeout'));
    expect(await reconcileAcceptedRequests(db as never, NOW, { stripeFor: () => stripe })).toEqual({ confirmed: 0, expired: 0 });
    expect(db.villaBookingRequest.updateMany).not.toHaveBeenCalled();
  });

  it('sin clave para mirarla tampoco la caduca', async () => {
    const db = fakeDb();
    db.villaBookingRequest.findMany.mockResolvedValueOnce([accepted({ paymentDueAt: new Date('2026-11-15T11:00:00Z') })]);
    expect(await reconcileAcceptedRequests(db as never, NOW, { stripeFor: () => null })).toEqual({ confirmed: 0, expired: 0 });
    expect(db.villaBookingRequest.updateMany).not.toHaveBeenCalled();
  });

  it('aceptada sin sesión y fuera de plazo: caduca', async () => {
    const db = fakeDb();
    db.villaBookingRequest.findMany.mockResolvedValueOnce([accepted({ stripeSessionId: null, paymentDueAt: new Date('2026-11-15T11:00:00Z') })]);
    expect(await reconcileAcceptedRequests(db as never, NOW, { stripeFor: () => null })).toEqual({ confirmed: 0, expired: 1 });
  });
});
