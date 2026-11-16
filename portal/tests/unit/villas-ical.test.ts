// Reserva propia para villas — leer y escribir iCal (lib/villas/ical.ts) y la
// lectura por HTTP que sustituye los bloqueos (lib/villas/ical-sync.ts).
import { describe, expect, it, vi } from 'vitest';
import { buildIcs, foldLine, parseIcs } from '@/lib/villas/ical';
import { isFeedDue, normalizeFeedUrl, syncFeed } from '@/lib/villas/ical-sync';
import { BlockedUrlError } from '@/lib/safe-fetch';

// Como exporta Airbnb: CRLF, fechas de día y una línea plegada.
const AIRBNB = [
  'BEGIN:VCALENDAR',
  'PRODID;X-RICAL-TZSOURCE=TZINFO:-//Airbnb Inc//Hosting Calendar 1.0//EN',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTEND;VALUE=DATE:20261221',
  'DTSTART;VALUE=DATE:20261214',
  'UID:1418fb94e984-0d0e3bbbd4b1a3d6b0d4c8d2b4e1f1aa@airbnb.com',
  'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HM\r\n X5Y2Z\\nPhone Number (Last 4 Digits): 1234',
  'SUMMARY:Reserved',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTEND;VALUE=DATE:20270105',
  'DTSTART;VALUE=DATE:20270102',
  'UID:7f3a@airbnb.com',
  'SUMMARY:Airbnb (Not available)',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

// Como Booking: LF, sin DTEND en uno, y un evento cancelado.
const BOOKING = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Booking.com//NONSGML//EN
BEGIN:VEVENT
UID:booking-1
DTSTART;VALUE=DATE:20261230
DTEND;VALUE=DATE:20270102
SUMMARY:CLOSED - Not available
END:VEVENT
BEGIN:VEVENT
UID:booking-2
DTSTART;VALUE=DATE:20270110
SUMMARY:CLOSED - Not available
END:VEVENT
BEGIN:VEVENT
UID:booking-3
STATUS:CANCELLED
DTSTART;VALUE=DATE:20270201
DTEND;VALUE=DATE:20270205
END:VEVENT
BEGIN:VEVENT
UID:other-4
DTSTART;TZID=Europe/Madrid:20270301T160000
DURATION:P3D
END:VEVENT
END:VCALENDAR
`;

describe('parseIcs', () => {
  it('lee lo que exporta Airbnb, con líneas plegadas', () => {
    const events = parseIcs(AIRBNB);
    expect(events).toEqual([
      { uid: '1418fb94e984-0d0e3bbbd4b1a3d6b0d4c8d2b4e1f1aa@airbnb.com', start: '2026-12-14', end: '2026-12-21', summary: 'Reserved' },
      { uid: '7f3a@airbnb.com', start: '2027-01-02', end: '2027-01-05', summary: 'Airbnb (Not available)' },
    ]);
  });

  it('sin DTEND es una noche, los cancelados no cuentan y DURATION se respeta', () => {
    const events = parseIcs(BOOKING);
    expect(events.map((e) => [e.uid, e.start, e.end])).toEqual([
      ['booking-1', '2026-12-30', '2027-01-02'],
      ['booking-2', '2027-01-10', '2027-01-11'],
      ['other-4', '2027-03-01', '2027-03-04'],
    ]);
  });

  it('ignora basura sin romperse', () => {
    expect(parseIcs('<html>Not found</html>')).toEqual([]);
    expect(parseIcs('BEGIN:VEVENT\nDTSTART:no-es-fecha\nEND:VEVENT')).toEqual([]);
  });
});

describe('buildIcs', () => {
  it('produce un calendario que se vuelve a leer igual', () => {
    const ics = buildIcs('Villa Alcornoque · Sombra Buena', [
      { uid: 'request-1@villas.kairikos', start: '2026-12-14', end: '2026-12-21', summary: 'Reservado' },
    ], new Date('2026-11-15T10:00:00Z'));
    expect(ics).toContain('\r\nDTSTART;VALUE=DATE:20261214\r\n');
    expect(ics).toContain('DTSTAMP:20261115T100000Z');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(parseIcs(ics)).toEqual([{ uid: 'request-1@villas.kairikos', start: '2026-12-14', end: '2026-12-21', summary: 'Reservado' }]);
  });

  it('pliega a 75 octetos sin partir un carácter', () => {
    const line = `SUMMARY:${'ñ'.repeat(80)}`;
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });

  it('escapa comas y punto y coma del nombre', () => {
    expect(buildIcs('Casa; la de abajo, sí', [])).toContain('X-WR-CALNAME:Casa\\; la de abajo\\, sí');
  });
});

describe('normalizeFeedUrl', () => {
  it('acepta https y webcal, rechaza el resto', () => {
    expect(normalizeFeedUrl('https://www.airbnb.es/calendar/ical/123.ics?s=abc')).toBe('https://www.airbnb.es/calendar/ical/123.ics?s=abc');
    expect(normalizeFeedUrl('webcal://admin.booking.com/hotel/ical.html?t=x')).toBe('https://admin.booking.com/hotel/ical.html?t=x');
    expect(normalizeFeedUrl('http://www.airbnb.es/calendar/ical/123.ics')).toBeNull();
    expect(normalizeFeedUrl('https://localhost/x.ics')).toBeNull();
    expect(normalizeFeedUrl('https://n8n/x.ics')).toBeNull();
    expect(normalizeFeedUrl('https://user:pw@example.com/x.ics')).toBeNull();
    expect(normalizeFeedUrl('no es una url')).toBeNull();
  });
});

describe('isFeedDue', () => {
  it('cada 30 minutos', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    expect(isFeedDue({ lastSyncedAt: null }, now)).toBe(true);
    expect(isFeedDue({ lastSyncedAt: new Date('2026-11-15T11:40:00Z') }, now)).toBe(false);
    expect(isFeedDue({ lastSyncedAt: new Date('2026-11-15T11:30:00Z') }, now)).toBe(true);
  });
});

function fakeDb() {
  const tx = {
    villaBlock: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }), createMany: vi.fn().mockResolvedValue({ count: 2 }) },
    villaCalendarFeed: { update: vi.fn().mockResolvedValue({}) },
  };
  const db = {
    ...tx,
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { db, tx };
}

describe('syncFeed', () => {
  const feed = { id: 'feed-1', villaId: 'villa-1', url: 'https://www.airbnb.es/calendar/ical/1.ics' };

  it('sustituye los bloqueos de ese calendario y guarda el estado', async () => {
    const { db, tx } = fakeDb();
    const fetchFn = vi.fn().mockResolvedValue(new Response(AIRBNB, { status: 200 }));
    const res = await syncFeed(db as never, feed, { today: '2026-11-15', fetchFn, now: new Date('2026-11-15T12:00:00Z') });
    expect(res).toEqual({ ok: true, events: 2 });
    expect(tx.villaBlock.deleteMany).toHaveBeenCalledWith({ where: { feedId: 'feed-1' } });
    const rows = tx.villaBlock.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ villaId: 'villa-1', feedId: 'feed-1', note: 'Reserved' });
    expect(rows[0].startDate.toISOString()).toBe('2026-12-14T00:00:00.000Z');
    expect(tx.villaCalendarFeed.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastStatus: 'ok', eventCount: 2 }) }));
  });

  it('deja fuera lo que ya terminó', async () => {
    const { db, tx } = fakeDb();
    const fetchFn = vi.fn().mockResolvedValue(new Response(AIRBNB, { status: 200 }));
    await syncFeed(db as never, feed, { today: '2027-01-03', fetchFn });
    expect(tx.villaBlock.createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it.each([
    ['un 404', () => Promise.resolve(new Response('no', { status: 404 })), 'http_404'],
    ['una página que no es iCal', () => Promise.resolve(new Response('<html></html>', { status: 200 })), 'not_ical'],
    ['una IP interna', () => Promise.reject(new BlockedUrlError('private_address')), 'url_not_allowed:private_address'],
    ['un fallo de red', () => Promise.reject(new Error('ECONNRESET')), 'network_error'],
  ])('con %s NO borra los bloqueos que había', async (_label, impl, error) => {
    const { db, tx } = fakeDb();
    const res = await syncFeed(db as never, feed, { today: '2026-11-15', fetchFn: vi.fn(impl) });
    expect(res).toEqual({ ok: false, error });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.villaBlock.deleteMany).not.toHaveBeenCalled();
    expect(tx.villaCalendarFeed.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastStatus: 'error', lastError: error }) }));
  });
});
