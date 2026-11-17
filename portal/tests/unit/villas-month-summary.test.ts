// Reserva propia para villas — el resumen del mes (panel-month-summary.ts) y
// las reglas del aviso de calendarios que fallan (feed-alert-rules.ts).
import { describe, expect, it } from 'vitest';
import { monthSummary, revenueInRange } from '@/lib/villas/panel-month-summary';
import { FEED_ALERT_AFTER_HOURS, feedErrorText, feedNeedsAlert } from '@/lib/villas/feed-alert-rules';

const stay = (over: Record<string, unknown>) => ({
  id: 's',
  villaId: 'v1',
  status: 'confirmed',
  reference: 'VR-1',
  guestName: 'Ana',
  checkIn: '2026-11-10',
  checkOut: '2026-11-14',
  totalCents: 100_000,
  ...over,
});

describe('revenueInRange', () => {
  it('reparte el total por noches y se queda las del mes', () => {
    // 4 noches: 28, 29, 30 de noviembre y 1 de diciembre.
    const s = { checkIn: '2026-11-28', checkOut: '2026-12-02', totalCents: 100_000 };
    expect(revenueInRange(s, '2026-11-01', '2026-12-01')).toBe(75_000);
    expect(revenueInRange(s, '2026-12-01', '2027-01-01')).toBe(25_000);
    expect(revenueInRange(s, '2026-10-01', '2026-11-01')).toBe(0);
  });
});

describe('monthSummary', () => {
  const villas = [
    {
      id: 'v1',
      manualBlocks: [{ id: 'm1', start: '2026-11-20', end: '2026-11-23', note: 'Pintura' }],
      importedBlocks: [
        { start: '2026-11-16', end: '2026-11-19', label: 'Airbnb' },
        // Airbnb reexporta nuestra reserva: esa noche cuenta una vez, como nuestra.
        { start: '2026-11-13', end: '2026-11-14', label: 'Airbnb' },
      ],
    },
    { id: 'v2', manualBlocks: [], importedBlocks: [] },
  ];

  it('cuenta cada noche una vez y solo las confirmadas como vendidas', () => {
    const stays = [
      stay({}),
      stay({ id: 'acc', status: 'accepted', checkIn: '2026-11-24', checkOut: '2026-11-26' }),
      stay({ id: 'v2s', villaId: 'v2', checkIn: '2026-11-29', checkOut: '2026-12-03', totalCents: 80_000 }),
    ];
    const s = monthSummary('2026-11-17', villas, stays, '2026-11-15');
    expect(s.month).toBe('2026-11-01');
    expect(s.rows[0]).toEqual({ villaId: 'v1', nights: 30, soldHere: 4, external: 3, closed: 3, available: 27, occupancyPct: 26, revenueCents: 100_000 });
    expect(s.rows[1]).toEqual({ villaId: 'v2', nights: 30, soldHere: 2, external: 0, closed: 0, available: 30, occupancyPct: 7, revenueCents: 40_000 });
    expect(s.total).toEqual({ nights: 60, soldHere: 6, external: 3, closed: 3, available: 57, occupancyPct: 16, revenueCents: 140_000 });
    expect(s.externalKnownFrom).toBe('2026-11-14');
  });

  it('sin noches disponibles no inventa un porcentaje', () => {
    const closedAll = [{ id: 'v1', manualBlocks: [{ id: 'm', start: '2026-02-01', end: '2026-03-01', note: null }], importedBlocks: [] }];
    expect(monthSummary('2026-02-01', closedAll, [], '2026-01-10').total.occupancyPct).toBeNull();
  });
});

describe('aviso de calendarios que fallan', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  it('avisa una vez por racha y solo pasado el margen', () => {
    expect(feedNeedsAlert({ lastStatus: 'error', errorSince: hoursAgo(FEED_ALERT_AFTER_HOURS), alertedAt: null }, now)).toBe(true);
    expect(feedNeedsAlert({ lastStatus: 'error', errorSince: hoursAgo(FEED_ALERT_AFTER_HOURS - 0.5), alertedAt: null }, now)).toBe(false);
    expect(feedNeedsAlert({ lastStatus: 'error', errorSince: hoursAgo(10), alertedAt: hoursAgo(5) }, now)).toBe(false);
    expect(feedNeedsAlert({ lastStatus: 'ok', errorSince: null, alertedAt: null }, now)).toBe(false);
  });

  it('explica el error en palabras del dueño', () => {
    expect(feedErrorText('http_404')).toContain('ya no existe');
    expect(feedErrorText('http_503')).toContain('no responde bien');
    expect(feedErrorText('http_418')).toContain('(418)');
    expect(feedErrorText('not_ical')).toContain('no devuelve un calendario');
    expect(feedErrorText('url_not_allowed:private_address')).toContain('no está permitida');
    expect(feedErrorText('algo_nuevo')).toBe('no se ha podido leer (algo_nuevo)');
  });
});
