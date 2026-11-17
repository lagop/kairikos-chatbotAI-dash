// Reserva propia para villas — reserva inmediata (createVillaRequest acepta sola
// si las fechas siguen libres) y el aviso al dueño de calendarios que fallan
// (alertFailingFeeds), contra un Prisma simulado.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendVillaEmail = vi.fn();
vi.mock('@/lib/villas/emails', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/villas/emails')>();
  return { ...original, sendVillaEmail: (...args: unknown[]) => sendVillaEmail(...args) };
});
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { createVillaRequest } from '@/lib/villas/requests';
import { alertFailingFeeds } from '@/lib/villas/feed-alerts';

const NOW = new Date('2026-11-15T12:00:00Z');
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

const rentalBase = {
  id: 'rental-1',
  clientId: 'client-1',
  tenantId: null,
  businessName: 'Villas Sombra Buena',
  ownerEmail: 'dueno@villas.example',
  ownerPhone: null,
  balanceNote: null,
  cancellationNote: null,
  confirmHours: 24,
  paymentHours: 48,
  depositPercent: 30,
  timeZone: 'Europe/Madrid',
  stripeKeyCiphertext: 'x',
  stripeKeyIv: 'y',
  stripeKeyTag: 'z',
};

function villa(instantBooking: boolean) {
  return {
    id: 'villa-1',
    rentalId: 'rental-1',
    clientId: 'client-1',
    slug: 'alcornoque',
    name: 'Villa Alcornoque',
    maxGuests: 6,
    nightlyCents: 18_000,
    minNights: 2,
    cleaningFeeCents: 6_000,
    vatRateBps: 1000,
    touristTaxCents: 0,
    icalToken: 't',
    isActive: true,
    instantBooking,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    seasons: [],
  };
}

const input = {
  villaSlug: 'alcornoque',
  checkIn: '2026-12-14',
  checkOut: '2026-12-21',
  adults: 2,
  children: 0,
  guestName: 'Ana López',
  guestEmail: 'Ana@Correo.example',
  guestPhone: null,
  message: null,
  lang: 'es' as const,
  source: null,
};

function fakeDb(rental: Record<string, unknown>) {
  let created: Record<string, unknown> | null = null;
  const db = {
    villaBookingRequest: {
      // 1.ª llamada: ¿hay un duplicado? 2.ª: la aceptación carga la solicitud.
      findFirst: vi.fn(async () => (created ? { ...created, villa: { id: 'villa-1', name: 'Villa Alcornoque' }, rental } : null)),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created = { id: REQUEST_ID, createdAt: NOW, decidedAt: null, paymentDueAt: null, declineReason: null, paidAt: null, ...data };
        return created;
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    villaBlock: { findMany: vi.fn().mockResolvedValue([]) },
    villaCalendarFeed: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    villaRentalAudit: { create: vi.fn().mockResolvedValue({}) },
    chatbotClient: { findUnique: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  return db;
}

const subjects = () => sendVillaEmail.mock.calls.map((c) => (c[1] as { subject: string }).subject);
const auditActions = (db: ReturnType<typeof fakeDb>) => db.villaRentalAudit.create.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action);

beforeEach(() => {
  sendVillaEmail.mockReset().mockResolvedValue({ ok: true });
});

describe('reserva inmediata', () => {
  it('sin activarla, la solicitud queda pendiente y no se leen los calendarios', async () => {
    const rental = { ...rentalBase, villas: [villa(false)] };
    const db = fakeDb(rental);
    const res = await createVillaRequest(db as never, rental as never, input, NOW);
    expect(res).toMatchObject({ ok: true, status: 'pending', paymentDueAt: null, duplicate: false });
    expect(db.villaCalendarFeed.findMany).not.toHaveBeenCalled();
    expect(subjects()).toEqual([expect.stringMatching(/^Nueva solicitud/), expect.stringMatching(/^Hemos recibido tu solicitud/)]);
  });

  it('con las fechas libres la acepta sola: el huésped va a pagar y el dueño recibe el aviso', async () => {
    const rental = { ...rentalBase, villas: [villa(true)] };
    const db = fakeDb(rental);
    const res = await createVillaRequest(db as never, rental as never, input, NOW);
    expect(res).toMatchObject({ ok: true, status: 'accepted', paymentDueAt: '2026-11-17T12:00:00.000Z' });
    expect(db.villaBookingRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, status: 'pending' },
      data: { status: 'accepted', decidedAt: NOW, paymentDueAt: new Date('2026-11-17T12:00:00Z') },
    });
    expect(auditActions(db)).toEqual(['requested', 'accepted']);
    expect(db.villaRentalAudit.create.mock.calls[1][0].data.actor).toBe('system:instant');
    // Ni «hemos recibido tu solicitud» ni «nueva solicitud»: no hay nada que esperar.
    expect(subjects()).toEqual([expect.stringMatching(/^Tu solicitud está aceptada/), expect.stringMatching(/^Reserva inmediata · Villa Alcornoque/)]);
    expect(sendVillaEmail.mock.calls[0][0]).toBe('ana@correo.example');
    expect(sendVillaEmail.mock.calls[1][0]).toBe('dueno@villas.example');
  });

  it('si un calendario no se puede leer, no la acepta sola y el dueño sabe por qué', async () => {
    const rental = { ...rentalBase, villas: [villa(true)] };
    const db = fakeDb(rental);
    db.villaCalendarFeed.findMany.mockResolvedValue([{ id: 'feed-1', villaId: 'villa-1', url: 'https://www.airbnb.es/calendar/ical/1.ics' }]);
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const res = await createVillaRequest(db as never, rental as never, input, NOW, { fetchFn });
    expect(res).toMatchObject({ ok: true, status: 'pending' });
    expect(db.villaBookingRequest.updateMany).not.toHaveBeenCalled();
    expect(auditActions(db)).toEqual(['requested', 'instant_fallback']);
    expect(db.villaRentalAudit.create.mock.calls[1][0].data.metadata).toEqual({ reason: 'feeds_failed' });
    expect(subjects()).toEqual([expect.stringMatching(/^Nueva solicitud/), expect.stringMatching(/^Hemos recibido tu solicitud/)]);
    expect((sendVillaEmail.mock.calls[0][1] as { text: string }).text).toContain('no se ha podido leer alguno de tus calendarios');
  });

  it('si al releer Airbnb ya tiene esas noches, queda pendiente', async () => {
    const rental = { ...rentalBase, villas: [villa(true)] };
    const db = fakeDb(rental);
    // Libre al crear (1.ª lectura), ocupada al aceptar (2.ª, tras releer el iCal).
    db.villaBlock.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'b1', startDate: new Date('2026-12-18T00:00:00Z'), endDate: new Date('2026-12-20T00:00:00Z'), feedId: 'f1', note: null, feed: { label: 'Airbnb' } }]);
    const res = await createVillaRequest(db as never, rental as never, input, NOW);
    expect(res).toMatchObject({ ok: true, status: 'pending' });
    expect(db.villaRentalAudit.create.mock.calls[1][0].data.metadata).toEqual({ reason: 'conflict' });
    expect((sendVillaEmail.mock.calls[0][1] as { text: string }).text).toContain('alguna de esas noches ya estaba ocupada');
  });

  it('sin clave de Stripe no la acepta sola', async () => {
    const rental = { ...rentalBase, stripeKeyCiphertext: null, villas: [villa(true)] };
    const db = fakeDb(rental);
    const res = await createVillaRequest(db as never, rental as never, input, NOW);
    expect(res).toMatchObject({ ok: true, status: 'pending' });
    expect(db.villaRentalAudit.create.mock.calls[1][0].data.metadata).toEqual({ reason: 'stripe_not_configured' });
  });

  it('un doble envío tras aceptarla devuelve la misma, ya aceptada', async () => {
    const rental = { ...rentalBase, villas: [villa(true)] };
    const db = fakeDb(rental);
    db.villaBookingRequest.findFirst.mockResolvedValueOnce({
      reference: 'VR-ABC234',
      guestToken: 'g'.repeat(32),
      status: 'accepted',
      paymentDueAt: new Date('2026-11-17T12:00:00Z'),
    } as never);
    const res = await createVillaRequest(db as never, rental as never, input, NOW);
    expect(res).toMatchObject({ ok: true, duplicate: true, status: 'accepted', paymentDueAt: '2026-11-17T12:00:00.000Z', reference: 'VR-ABC234' });
    expect(db.villaBookingRequest.findFirst.mock.calls[0][0]).toMatchObject({ where: { status: { in: ['pending', 'accepted'] } } });
    expect(db.villaBookingRequest.create).not.toHaveBeenCalled();
    expect(sendVillaEmail).not.toHaveBeenCalled();
  });
});

describe('aviso de calendarios que fallan', () => {
  const since = new Date('2026-11-15T08:00:00Z'); // cuatro horas antes de NOW
  function feedRow(id: string, rentalId: string, over: Record<string, unknown> = {}) {
    return {
      id,
      label: 'Airbnb',
      url: `https://www.airbnb.es/calendar/ical/${id}.ics?s=secreto`,
      lastStatus: 'error',
      lastError: 'http_404',
      errorSince: since,
      alertedAt: null,
      villa: {
        name: `Villa ${id}`,
        instantBooking: false,
        rental: { id: rentalId, clientId: `client-${rentalId}`, businessName: `Negocio ${rentalId}`, ownerEmail: `${rentalId}@villas.example`, timeZone: 'Europe/Madrid' },
      },
      ...over,
    };
  }

  function alertsDb(rows: unknown[]) {
    return {
      villaCalendarFeed: { findMany: vi.fn().mockResolvedValue(rows), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      villaRentalAudit: { create: vi.fn().mockResolvedValue({}) },
      chatbotClient: { findUnique: vi.fn().mockResolvedValue(null) },
    };
  }

  it('un correo por dueño con todos sus calendarios, sin la URL secreta en la auditoría', async () => {
    const db = alertsDb([feedRow('a', 'r1'), feedRow('b', 'r1', { lastError: 'not_ical' }), feedRow('c', 'r2')]);
    expect(await alertFailingFeeds(db as never, NOW)).toBe(2);
    expect(db.villaCalendarFeed.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['a', 'b'] }, alertedAt: null }, data: { alertedAt: NOW } });
    expect(sendVillaEmail).toHaveBeenCalledTimes(2);
    const [to, email] = sendVillaEmail.mock.calls[0] as [string, { subject: string; text: string }];
    expect(to).toBe('r1@villas.example');
    expect(email.subject).toBe('No podemos leer 2 calendarios de tus villas');
    expect(email.text).toContain('Villa a · Airbnb (www.airbnb.es)');
    expect(email.text).toContain('esa URL ya no existe');
    expect(email.text).toContain('no devuelve un calendario');
    expect(JSON.stringify(db.villaRentalAudit.create.mock.calls)).not.toContain('secreto');
    expect((sendVillaEmail.mock.calls[1][1] as { subject: string }).subject).toBe('No podemos leer el calendario de Airbnb de Villa c');
  });

  it('si otro pase del cron ya los marcó, no manda nada', async () => {
    const db = alertsDb([feedRow('a', 'r1')]);
    db.villaCalendarFeed.updateMany.mockResolvedValue({ count: 0 });
    expect(await alertFailingFeeds(db as never, NOW)).toBe(0);
    expect(sendVillaEmail).not.toHaveBeenCalled();
  });

  it('una racha corta no avisa todavía', async () => {
    const db = alertsDb([feedRow('a', 'r1', { errorSince: new Date('2026-11-15T10:30:00Z') })]);
    expect(await alertFailingFeeds(db as never, NOW)).toBe(0);
    expect(db.villaCalendarFeed.updateMany).not.toHaveBeenCalled();
  });

  it('con reserva inmediata, el correo dice que queda en pausa', async () => {
    const row = feedRow('a', 'r1');
    const db = alertsDb([{ ...row, villa: { ...row.villa, instantBooking: true } }]);
    await alertFailingFeeds(db as never, NOW);
    expect((sendVillaEmail.mock.calls[0][1] as { text: string }).text).toContain('La reserva inmediata de esa villa queda en pausa');
  });
});
