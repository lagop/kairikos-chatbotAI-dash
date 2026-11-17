import { describe, expect, it } from 'vitest';
import {
  CALENDAR_MONTHS_AHEAD,
  CALENDAR_MONTHS_BACK,
  calendarHistoryStart,
  checkCloseRange,
  clampMonth,
  entriesInRange,
  monthWeeks,
  nightFor,
  occupancyForVilla,
  rangeFromNights,
  type OccupancyRange,
} from '@/lib/villas/panel-calendar';

const villa = {
  id: 'v1',
  manualBlocks: [{ id: 'b1', start: '2026-12-24', end: '2026-12-27', note: 'Familia' }],
  importedBlocks: [{ start: '2026-12-10', end: '2026-12-14', label: 'Airbnb' }],
};
const request = (id: string, status: string, checkIn: string, checkOut: string, villaId = 'v1') => ({
  id,
  villaId,
  status,
  reference: `VIL-${id}`,
  guestName: 'Marta G.',
  checkIn,
  checkOut,
});

describe('occupancyForVilla', () => {
  it('junta solicitudes, iCal y cierres manuales de esa villa, con su texto', () => {
    const ranges = occupancyForVilla(villa, [request('a', 'confirmed', '2026-12-01', '2026-12-05')]);
    expect(ranges.map((r) => r.kind)).toEqual(['confirmed', 'ical', 'manual']);
    expect(ranges.map((r) => r.label)).toEqual(['Reserva confirmada · VIL-a · Marta G.', 'Ocupado en Airbnb', 'Cerrada a mano · Familia']);
  });

  it('ignora las solicitudes de otra villa y las que ya no cuentan', () => {
    const ranges = occupancyForVilla({ ...villa, manualBlocks: [], importedBlocks: [] }, [
      request('otra', 'confirmed', '2026-12-01', '2026-12-05', 'v2'),
      request('rechazada', 'declined', '2026-12-01', '2026-12-05'),
      request('caducada', 'expired', '2026-12-01', '2026-12-05'),
      request('cancelada', 'cancelled', '2026-12-01', '2026-12-05'),
      request('pendiente', 'pending', '2026-12-01', '2026-12-05'),
    ]);
    expect(ranges.map((r) => r.id)).toEqual(['pendiente']);
  });
});

describe('nightFor', () => {
  const ranges: OccupancyRange[] = [
    { id: 'r1', kind: 'confirmed', start: '2026-12-01', end: '2026-12-05', label: 'Reserva' },
    { id: 'p1', kind: 'pending', start: '2026-12-04', end: '2026-12-08', label: 'Solicitud' },
    { id: 'i1', kind: 'ical', start: '2026-12-03', end: '2026-12-04', label: 'Airbnb' },
  ];

  it('la noche de salida queda libre: rangos [entrada, salida)', () => {
    expect(nightFor('2026-12-01', ranges).kind).toBe('confirmed');
    expect(nightFor('2026-11-30', ranges).kind).toBeNull();
    expect(nightFor('2026-12-08', ranges).entries).toEqual([]);
  });

  it('manda lo que bloquea sobre lo pendiente, y una pendiente sola no es conflicto', () => {
    const night = nightFor('2026-12-04', ranges);
    expect(night.entries.map((e) => e.kind)).toEqual(['confirmed', 'pending']);
    expect(night.kind).toBe('confirmed');
    expect(night.conflict).toBe(false);
    expect(nightFor('2026-12-06', ranges)).toMatchObject({ kind: 'pending', conflict: false });
  });

  it('dos cosas que bloquean la misma noche son una doble reserva', () => {
    expect(nightFor('2026-12-03', ranges)).toMatchObject({ kind: 'confirmed', conflict: true });
  });
});

describe('monthWeeks', () => {
  it('diciembre de 2026 empieza en martes: un hueco delante y semanas de siete', () => {
    const weeks = monthWeeks('2026-12-15', []);
    expect(weeks[0][0]).toBeNull();
    expect(weeks[0][1]?.date).toBe('2026-12-01');
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    const days = weeks.flat().filter(Boolean);
    expect(days).toHaveLength(31);
    expect(days[30]?.date).toBe('2026-12-31');
  });

  it('un mes que empieza en lunes no lleva huecos delante; febrero bisiesto tiene 29', () => {
    expect(monthWeeks('2027-02-01', [])[0][0]?.date).toBe('2027-02-01');
    expect(monthWeeks('2028-02-10', []).flat().filter(Boolean)).toHaveLength(29);
  });

  it('un mes que empieza en domingo lleva seis huecos', () => {
    const first = monthWeeks('2026-11-01', [])[0];
    expect(first.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(first[6]?.date).toBe('2026-11-01');
  });

  it('pinta un rango que viene del mes anterior y sigue en el siguiente', () => {
    const weeks = monthWeeks('2026-12-01', [{ id: 'x', kind: 'manual', start: '2026-11-20', end: '2027-01-10', label: 'Obras' }]);
    expect(weeks.flat().filter(Boolean).every((n) => n?.kind === 'manual')).toBe(true);
  });
});

describe('clampMonth', () => {
  it('va de doce meses atrás a diecisiete adelante', () => {
    expect(CALENDAR_MONTHS_BACK).toBe(12);
    expect(CALENDAR_MONTHS_AHEAD).toBe(17);
    expect(calendarHistoryStart('2026-11-17')).toBe('2025-11-01');
    expect(clampMonth('2026-10-20', '2026-11-17')).toBe('2026-10-01');
    expect(clampMonth('2020-01-01', '2026-11-17')).toBe('2025-11-01');
    expect(clampMonth('2026-12-20', '2026-11-17')).toBe('2026-12-01');
    expect(clampMonth('2040-01-01', '2026-11-17')).toBe('2028-04-01');
  });
});

describe('rangos seleccionados en el calendario', () => {
  const ranges: OccupancyRange[] = [
    { id: 'r1', kind: 'confirmed', start: '2026-12-10', end: '2026-12-14', label: 'Reserva' },
    { id: 'p1', kind: 'pending', start: '2026-12-02', end: '2026-12-05', label: 'Solicitud' },
    { id: 'i1', kind: 'ical', start: '2026-12-12', end: '2026-12-13', label: 'Airbnb' },
  ];

  it('dos noches pulsadas, en cualquier orden, cierran también la última', () => {
    expect(rangeFromNights('2026-12-03', '2026-12-01')).toEqual({ start: '2026-12-01', end: '2026-12-04' });
    expect(rangeFromNights('2026-12-01', '2026-12-01')).toEqual({ start: '2026-12-01', end: '2026-12-02' });
  });

  it('entriesInRange respeta [entrada, salida) y puede dejar fuera la propia solicitud', () => {
    expect(entriesInRange(ranges, '2026-12-05', '2026-12-10')).toEqual([]);
    expect(entriesInRange(ranges, '2026-12-01', '2026-12-13').map((r) => r.id)).toEqual(['r1', 'i1', 'p1']);
    expect(entriesInRange(ranges, '2026-12-10', '2026-12-14', 'r1').map((r) => r.id)).toEqual(['i1']);
  });

  it('se pueden cerrar noches libres, avisando de las solicitudes que quedan dentro', () => {
    expect(checkCloseRange(ranges, '2026-12-05', '2026-12-10', '2026-11-17')).toEqual({ ok: true, nights: 5, pending: [] });
    const withPending = checkCloseRange(ranges, '2026-12-01', '2026-12-06', '2026-11-17');
    expect(withPending.ok && withPending.pending.map((r) => r.id)).toEqual(['p1']);
  });

  it('no se cierra en el pasado, encima de algo que ocupa, ni más de un año', () => {
    expect(checkCloseRange(ranges, '2026-11-16', '2026-11-18', '2026-11-17')).toMatchObject({ ok: false, reason: 'past' });
    expect(checkCloseRange(ranges, '2026-12-08', '2026-12-11', '2026-11-17')).toMatchObject({ ok: false, reason: 'occupied' });
    expect(checkCloseRange([], '2026-12-01', '2027-12-03', '2026-11-17')).toMatchObject({ ok: false, reason: 'too_long' });
    expect(checkCloseRange([], '2026-11-17', '2026-11-18', '2026-11-17').ok).toBe(true);
  });
});
