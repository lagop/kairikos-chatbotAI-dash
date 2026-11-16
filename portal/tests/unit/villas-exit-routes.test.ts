// Reserva propia para villas — baja del cliente en las rutas públicas: el
// widget distingue «sin servicio» de un fallo, y el iCal se congela durante el
// plazo de gracia en vez de vaciarse (docs/plan-reserva-villas.md).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  villaFindFirst: vi.fn(),
  rentalFindFirst: vi.fn(),
  rentalCount: vi.fn(),
  blocks: vi.fn(),
  requests: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    villa: { findFirst: (...a: unknown[]) => state.villaFindFirst(...a) },
    villaRental: { findFirst: (...a: unknown[]) => state.rentalFindFirst(...a), count: (...a: unknown[]) => state.rentalCount(...a) },
    villaBlock: { findMany: (...a: unknown[]) => state.blocks(...a) },
    villaBookingRequest: { findMany: (...a: unknown[]) => state.requests(...a) },
  },
}));

import { GET as icalGet } from '@/app/api/public/villas/ical/[file]/route';
import { GET as infoGet } from '@/app/api/public/villas/[token]/route';

const DAY = 86_400_000;
const TOKEN = 'ical_abcdefghijklmnopqrstuv';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function villa(contract: { status: string; cancelledAt: Date | null }, exitNotifiedAt: Date | null = null) {
  return {
    id: 'villa-1',
    name: 'Villa Alcornoque',
    rental: {
      timeZone: 'Europe/Madrid',
      businessName: 'Villas Sombra Buena',
      exitNotifiedAt,
      clientProduct: { ...contract, changedAt: contract.cancelledAt ?? new Date('2026-01-01T00:00:00Z') },
    },
  };
}

const getIcs = () => icalGet(new NextRequest(`http://localhost/api/public/villas/ical/${TOKEN}.ics`), { params: Promise.resolve({ file: `${TOKEN}.ics` }) });
const unfold = (s: string) => s.replace(/\r\n /g, '');

beforeEach(() => {
  vi.useRealTimers();
  Object.values(state).forEach((f) => f.mockReset());
  state.blocks.mockResolvedValue([]);
  state.requests.mockResolvedValue([{ id: 'r1', checkIn: day('2030-01-10'), checkOut: day('2030-01-14'), reference: 'VR-ABC234' }]);
});

describe('iCal público y baja', () => {
  it('activa: calendario normal, sin descripción', async () => {
    state.villaFindFirst.mockResolvedValue(villa({ status: 'active', cancelledAt: null }));
    const res = await getIcs();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('DTSTART;VALUE=DATE:20300110');
    expect(body).not.toContain('X-WR-CALDESC');
    expect(body).not.toContain('VR-ABC234'); // la URL la guardan terceros
  });

  it('dada de baja dentro del plazo: sigue bloqueando lo que había y dice que no se actualiza', async () => {
    const cancelledAt = new Date(Date.now() - 3 * DAY);
    state.villaFindFirst.mockResolvedValue(villa({ status: 'cancelled', cancelledAt }, cancelledAt));
    const res = await getIcs();
    expect(res.status).toBe(200);
    const body = unfold(await res.text());
    expect(body).toContain('DTSTART;VALUE=DATE:20300110');
    expect(body).toContain('X-WR-CALDESC:Calendario de Kairikos SIN ACTUALIZAR desde el');
    expect(body).toContain('Quita esta URL de Airbnb y Booking.');
  });

  it('pausada: también congelada, no vacía', async () => {
    state.villaFindFirst.mockResolvedValue(villa({ status: 'paused', cancelledAt: null }));
    const body = unfold(await (await getIcs()).text());
    expect(body).toContain('DTSTART;VALUE=DATE:20300110');
    expect(body).toContain('X-WR-CALDESC:Calendario de Kairikos en pausa');
  });

  it('fuera de plazo: 404', async () => {
    const cancelledAt = new Date(Date.now() - 40 * DAY);
    state.villaFindFirst.mockResolvedValue(villa({ status: 'cancelled', cancelledAt }, cancelledAt));
    expect((await getIcs()).status).toBe(404);
  });

  it('ya no filtra por contratación activa en la consulta (lo decide serviceState)', async () => {
    state.villaFindFirst.mockResolvedValue(null);
    await getIcs();
    expect(state.villaFindFirst.mock.calls[0][0].where).toEqual({ icalToken: TOKEN, isActive: true });
  });
});

describe('arranque del widget sin servicio', () => {
  const getInfo = (token: string) => infoGet(new NextRequest(`http://localhost/api/public/villas/${token}`), { params: Promise.resolve({ token }) });

  it('token que existió pero sin contratación activa: 404 not_contracted', async () => {
    state.rentalFindFirst.mockResolvedValue(null);
    state.rentalCount.mockResolvedValue(1);
    const res = await getInfo('vil_abcdefghijklmnopqrstuv');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_contracted' });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('token que no existe: 404 not_found, sin mirar la base para formatos raros', async () => {
    state.rentalFindFirst.mockResolvedValue(null);
    state.rentalCount.mockResolvedValue(0);
    expect(await (await getInfo('vil_abcdefghijklmnopqrstuv')).json()).toEqual({ error: 'not_found' });
    expect(await (await getInfo('cualquier-cosa')).json()).toEqual({ error: 'not_found' });
    expect(state.rentalCount).toHaveBeenCalledTimes(1);
  });
});
