// Reserva propia para villas — baja del cliente (docs/plan-reserva-villas.md,
// «Baja del cliente»): plazo de gracia, exportaciones, aviso y purga del cron.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { EXIT_GRACE_DAYS, frozenCalendarDescription, graceEndsAt, serviceState } from '@/lib/villas/exit-rules';
import { auditRecord, euros, exportEvents, exportFileName, requestRecord, villaRecords, REQUEST_COLUMNS } from '@/lib/villas/export-format';
import { buildCsv } from '@/lib/lead-export';
import { buildIcs, parseIcs } from '@/lib/villas/ical';
import { processVillaExits } from '@/lib/villas/exit';

const DAY = 86_400_000;
const CANCELLED = new Date('2026-11-16T10:00:00Z');
const cancelled = { status: 'cancelled', cancelledAt: CANCELLED, changedAt: CANCELLED };

describe('plazo de gracia', () => {
  it('activa, pausada o con impago no corren plazo', () => {
    const now = new Date('2027-06-01T00:00:00Z');
    expect(serviceState({ status: 'active', cancelledAt: null, changedAt: now }, null, now)).toEqual({ state: 'active', graceEndsAt: null });
    expect(serviceState({ status: 'paused', cancelledAt: null, changedAt: CANCELLED }, null, now).state).toBe('suspended');
    expect(serviceState({ status: 'past_due', cancelledAt: null, changedAt: CANCELLED }, null, now).state).toBe('suspended');
  });

  it(`son ${EXIT_GRACE_DAYS} días desde la baja`, () => {
    const notified = new Date(CANCELLED.getTime() + 5 * 60_000);
    const ends = new Date(CANCELLED.getTime() + 30 * DAY);
    expect(serviceState(cancelled, notified, new Date(ends.getTime() - 1))).toEqual({ state: 'grace', graceEndsAt: ends });
    expect(serviceState(cancelled, notified, ends)).toEqual({ state: 'closed', graceEndsAt: ends });
  });

  it('sin aviso al dueño nunca se cierra', () => {
    expect(serviceState(cancelled, null, new Date('2028-01-01T00:00:00Z')).state).toBe('grace');
  });

  it('un aviso tardío deja al menos 7 días', () => {
    const notified = new Date(CANCELLED.getTime() + 28 * DAY);
    expect(graceEndsAt(cancelled, notified)).toEqual(new Date(notified.getTime() + 7 * DAY));
  });

  it('sin fecha de baja cuenta el último cambio de estado', () => {
    const changedAt = new Date('2026-10-01T00:00:00Z');
    expect(graceEndsAt({ status: 'cancelled', cancelledAt: null, changedAt }, null)).toEqual(new Date(changedAt.getTime() + 30 * DAY));
  });

  it('el iCal congelado dice desde cuándo y qué hacer', () => {
    expect(frozenCalendarDescription(CANCELLED, 'grace')).toBe(
      'Calendario de Kairikos SIN ACTUALIZAR desde el 16 de noviembre de 2026: el servicio de reservas se ha dado de baja. Quita esta URL de Airbnb y Booking.',
    );
    const ics = buildIcs('Villa', [], CANCELLED, frozenCalendarDescription(CANCELLED, 'suspended'));
    // Plegada a 75 octetos como cualquier línea larga: se despliega para leerla.
    expect(ics.replace(/\r\n /g, '')).toContain('X-WR-CALDESC:Calendario de Kairikos en pausa desde el 16 de noviembre de 2026: las fechas no se actualizan');
  });
});

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('exportación', () => {
  const request = {
    reference: 'VR-ABC234',
    status: 'confirmed',
    declineReason: null,
    checkIn: day('2026-12-01'),
    checkOut: day('2026-12-04'),
    adults: 2,
    children: 1,
    guestName: 'Ana López',
    guestEmail: 'ana@correo.example',
    guestPhone: '+34 600 000 000',
    lang: 'es',
    message: '=HYPERLINK("http://malo.example")',
    totalCents: 60_000,
    depositCents: 18_000,
    currency: 'EUR',
    quote: { vatCents: 5_455 },
    createdAt: new Date('2026-11-15T23:00:00Z'),
    consentAt: new Date('2026-11-15T23:00:00Z'),
    decidedAt: new Date('2026-11-16T08:00:00Z'),
    paymentDueAt: new Date('2026-11-18T08:00:00Z'),
    paidAt: new Date('2026-11-16T09:00:00Z'),
    stripePaymentIntentId: 'pi_1',
    source: 'google',
    villa: { name: 'Villa Castaño' },
  };

  it('importes en euros con punto decimal', () => {
    expect(euros(60_000)).toBe('600.00');
    expect(euros(5)).toBe('0.05');
    expect(euros(-1_250)).toBe('-12.50');
    expect(euros(null)).toBe('');
  });

  it('una solicitud lleva todo lo del huésped y la reserva', () => {
    const rec = requestRecord(request);
    expect(rec).toMatchObject({
      reference: 'VR-ABC234',
      villa: 'Villa Castaño',
      status: 'confirmed',
      statusText: 'confirmada',
      checkIn: '2026-12-01',
      checkOut: '2026-12-04',
      nights: 3,
      guestEmail: 'ana@correo.example',
      guestPhone: '+34 600 000 000',
      total: '600.00',
      vat: '54.55',
      deposit: '180.00',
      balance: '420.00',
      paidAt: '2026-11-16T09:00:00.000Z',
    });
    expect(Object.keys(rec).sort()).toEqual(REQUEST_COLUMNS.map((c) => c.key).sort());
  });

  it('el CSV no deja pasar fórmulas', () => {
    const csv = buildCsv([requestRecord(request)], REQUEST_COLUMNS);
    expect(csv.split('\r\n')[0]).toMatch(/^referencia,villa,estado,/);
    expect(csv).toContain(`"'=HYPERLINK(""http://malo.example"")"`);
  });

  it('villas: una fila base, una por temporada y una por calendario importado', () => {
    const rows = villaRecords({
      name: 'Villa Encina',
      slug: 'encina',
      maxGuests: 2,
      nightlyCents: 14_000,
      minNights: 2,
      cleaningFeeCents: 4_500,
      vatRateBps: 1000,
      touristTaxCents: 0,
      isActive: true,
      seasons: [{ name: 'Navidad', startDate: day('2026-12-20'), endDate: day('2027-01-06'), nightlyCents: 22_400, minNights: 4 }],
      feeds: [{ label: 'Airbnb', url: 'https://www.airbnb.es/calendar/ical/1.ics?s=x' }],
    });
    expect(rows.map((r) => r.kind)).toEqual(['base', 'temporada', 'calendario_importado']);
    expect(rows[0]).toMatchObject({ nightly: '140.00', cleaning: '45.00', vatPct: '10', active: 'si' });
    expect(rows[1]).toMatchObject({ name: 'Navidad', start: '2026-12-20', end: '2027-01-06', nightly: '224.00', minNights: 4 });
    expect(rows[2]).toMatchObject({ url: 'https://www.airbnb.es/calendar/ical/1.ics?s=x' });
  });

  it('el .ics del dueño lleva referencia, huésped y notas, ordenado', () => {
    const events = exportEvents(
      [{ id: 'r1', reference: 'VR-ABC234', guestName: 'Ana López', checkIn: day('2026-12-01'), checkOut: day('2026-12-04') }],
      [
        { id: 'b1', startDate: day('2026-11-20'), endDate: day('2026-11-22'), note: 'Pintura', feed: null },
        { id: 'b2', startDate: day('2026-12-10'), endDate: day('2026-12-12'), note: null, feed: { label: 'Booking' } },
      ],
    );
    expect(events.map((e) => e.summary)).toEqual(['No disponible · Pintura', 'Reserva VR-ABC234 · Ana López', 'No disponible (Booking)']);
    expect(parseIcs(buildIcs('x', events))).toHaveLength(3);
  });

  it('la auditoría guarda los detalles como JSON', () => {
    expect(auditRecord({ createdAt: CANCELLED, entity: 'request', entityId: 'r1', action: 'accepted', actor: 'client:c1', metadata: { a: 1 } })).toMatchObject({ metadata: '{"a":1}' });
    expect(auditRecord({ createdAt: CANCELLED, entity: 'rental', entityId: 'x', action: 'created', actor: 'system', metadata: {} }).metadata).toBe('');
  });

  it('nombres de archivo sin acentos ni espacios', () => {
    expect(exportFileName('solicitudes', 'Villas Sombra Buena (demo)', CANCELLED)).toBe('villas-sombra-buena-demo-solicitudes-2026-11-16.csv');
    expect(exportFileName('ics', 'Ñandú & Cía', CANCELLED, 'castano')).toBe('nandu-cia-castano-2026-11-16.ics');
  });
});

function rentalRow(over: Record<string, unknown> = {}) {
  return {
    id: 'rental-1',
    clientId: 'client-1',
    tenantId: null,
    businessName: 'Villas Sombra Buena',
    ownerEmail: 'dueno@villas.example',
    timeZone: 'Europe/Madrid',
    exitNotifiedAt: null,
    clientProductId: 'cp-1',
    clientProduct: { ...cancelled, productId: 'prod-villas' },
    villas: [{ name: 'Villa Alcornoque' }, { name: 'Villa Castaño' }],
    ...over,
  };
}

function fakeDb(rows: unknown[]) {
  const db = {
    villaRental: {
      findMany: vi.fn().mockResolvedValue(rows),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
    },
    villaBookingRequest: { count: vi.fn().mockResolvedValue(2) },
    villaRentalAudit: { create: vi.fn().mockResolvedValue({}) },
    clientProductAudit: { create: vi.fn().mockResolvedValue({}) },
    chatbotClient: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  return db;
}

describe('cron de bajas', () => {
  const send = vi.fn();
  beforeEach(() => {
    send.mockReset().mockResolvedValue({ ok: true });
  });

  it('avisa una vez al dueño, con el plazo y las reservas que siguen valiendo', async () => {
    const db = fakeDb([rentalRow()]);
    const now = new Date('2026-11-16T10:05:00Z');
    expect(await processVillaExits(db as never, now, { send })).toEqual({ notified: 1, purged: 0 });
    expect(db.villaRental.updateMany).toHaveBeenCalledWith({ where: { id: 'rental-1', exitNotifiedAt: null }, data: { exitNotifiedAt: now } });
    expect(db.villaRentalAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'exit_notified', metadata: { graceEndsAt: '2026-12-16T10:00:00.000Z', upcomingConfirmed: 2 } }),
    });
    const [to, email] = send.mock.calls[0];
    expect(to).toBe('dueno@villas.example');
    expect(email.subject).toContain('Baja de la reserva de villas');
    expect(email.text).toContain('Quita de Airbnb y Booking la URL de calendario de Kairikos de cada villa (Villa Alcornoque, Villa Castaño)');
    expect(email.text).toContain('Tienes 2 reserva(s) confirmada(s) por venir');
    expect(db.villaRental.delete).not.toHaveBeenCalled();
  });

  it('si otro pase ya avisó, no manda otro correo', async () => {
    const db = fakeDb([rentalRow()]);
    db.villaRental.updateMany.mockResolvedValue({ count: 0 });
    expect(await processVillaExits(db as never, new Date('2026-11-16T10:05:00Z'), { send })).toEqual({ notified: 0, purged: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('dentro del plazo no borra nada', async () => {
    const db = fakeDb([rentalRow({ exitNotifiedAt: new Date('2026-11-16T10:05:00Z') })]);
    expect(await processVillaExits(db as never, new Date('2026-12-16T09:59:00Z'), { send })).toEqual({ notified: 0, purged: 0 });
    expect(db.villaRental.delete).not.toHaveBeenCalled();
  });

  it('al acabar el plazo purga y lo deja en la auditoría de la contratación', async () => {
    const db = fakeDb([rentalRow({ exitNotifiedAt: new Date('2026-11-16T10:05:00Z') })]);
    expect(await processVillaExits(db as never, new Date('2026-12-16T10:00:00Z'), { send })).toEqual({ notified: 0, purged: 1 });
    expect(db.clientProductAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ clientProductId: 'cp-1', action: 'villas_data_purged', actorId: 'system:villas-exit' }),
    });
    expect(db.villaRental.delete).toHaveBeenCalledWith({ where: { id: 'rental-1' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('un fallo con un cliente no para a los demás', async () => {
    const db = fakeDb([rentalRow({ id: 'r-roto' }), rentalRow({ id: 'r-bien' })]);
    db.villaRental.updateMany.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ count: 1 });
    expect(await processVillaExits(db as never, new Date('2026-11-16T10:05:00Z'), { send })).toEqual({ notified: 1, purged: 0 });
  });
});
