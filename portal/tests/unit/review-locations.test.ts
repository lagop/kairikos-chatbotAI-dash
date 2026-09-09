// =============================================================================
// Fase 3 — unit tests para src/lib/review-locations.ts.
//
// Lo que se fija aquí:
//
//   • Que el tope de cada tarifa sea el que se vende. Si se separan, el
//     servidor regala o niega un producto que ya se cobró.
//   • Que una tarifa desconocida caiga a UNO y no a ilimitado: pasarse por
//     abajo hace que un cliente escriba; pasarse por arriba le regala el
//     producto y nadie se entera.
//   • Que resolver «en qué local» devuelva null cuando hay varios y no se
//     ha dicho cuál. Elegir uno por él es justo lo que esta fase quita.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  TIER_LOCATION_CAP,
  DEFAULT_LOCATION_CAP,
  locationCapForTier,
  getLocationAllowance,
  resolveReviewConnection,
  listReviewLocations,
} from '@/lib/review-locations';

const state = {
  clientProductFindFirst: vi.fn(),
  connectionCount: vi.fn(),
  connectionFindFirst: vi.fn(),
  connectionFindMany: vi.fn(),
};

const prisma = {
  clientProduct: { findFirst: (...a: unknown[]) => state.clientProductFindFirst(...a) },
  googleBusinessConnection: {
    count: (...a: unknown[]) => state.connectionCount(...a),
    findFirst: (...a: unknown[]) => state.connectionFindFirst(...a),
    findMany: (...a: unknown[]) => state.connectionFindMany(...a),
  },
} as unknown as PrismaClient;

beforeEach(() => {
  for (const fn of Object.values(state)) fn.mockReset();
  state.clientProductFindFirst.mockResolvedValue({ product: { tier: 'pro' } });
  state.connectionCount.mockResolvedValue(0);
  state.connectionFindMany.mockResolvedValue([]);
  state.connectionFindFirst.mockResolvedValue(null);
});

describe('locationCapForTier', () => {
  it('es el tope que se vende en cada tarifa', () => {
    expect(TIER_LOCATION_CAP).toEqual({ basic: 1, pro: 3, chain: 10 });
    expect(locationCapForTier('basic')).toBe(1);
    expect(locationCapForTier('pro')).toBe(3);
    expect(locationCapForTier('chain')).toBe(10);
  });

  it('una tarifa desconocida cae a uno, nunca a ilimitado', () => {
    expect(locationCapForTier('enterprise')).toBe(DEFAULT_LOCATION_CAP);
    expect(locationCapForTier(null)).toBe(1);
    expect(locationCapForTier(undefined)).toBe(1);
    expect(locationCapForTier('')).toBe(1);
  });
});

describe('getLocationAllowance', () => {
  it('descuenta los locales ya conectados del tope de la tarifa', async () => {
    state.connectionCount.mockResolvedValue(1);
    expect(await getLocationAllowance(prisma, 'c1')).toEqual({
      cap: 3,
      used: 1,
      remaining: 2,
      tier: 'pro',
    });
  });

  it('un local roto sigue ocupando sitio: arreglarlo no es conectar otro', async () => {
    await getLocationAllowance(prisma, 'c1');
    // Solo 'revoked' libera: 'needs_reconnect' es un local suyo pendiente.
    expect(state.connectionCount).toHaveBeenCalledWith({
      where: { clientId: 'c1', status: { not: 'revoked' } },
    });
  });

  it('no deja el resto en negativo si alguien bajó de tarifa', async () => {
    state.clientProductFindFirst.mockResolvedValue({ product: { tier: 'basic' } });
    state.connectionCount.mockResolvedValue(4);
    const allowance = await getLocationAllowance(prisma, 'c1');
    expect(allowance).toMatchObject({ cap: 1, used: 4, remaining: 0 });
  });

  it('sin producto de reseñas contratado, el tope es el de por defecto', async () => {
    state.clientProductFindFirst.mockResolvedValue(null);
    expect(await getLocationAllowance(prisma, 'c1')).toMatchObject({ cap: 1, tier: null });
  });
});

describe('resolveReviewConnection', () => {
  it('con un id, lo busca CON el clientId dentro de la consulta', async () => {
    state.connectionFindFirst.mockResolvedValue({ id: 'conn_1' });
    await resolveReviewConnection(prisma, 'c1', 'conn_1');
    // Un id de otra empresa no existe, en vez de existir y estar prohibido.
    expect(state.connectionFindFirst).toHaveBeenCalledWith({
      where: { id: 'conn_1', clientId: 'c1', status: 'active' },
    });
  });

  it('sin id y con un solo local, resuelve el suyo', async () => {
    state.connectionFindMany.mockResolvedValue([{ id: 'conn_1' }]);
    expect(await resolveReviewConnection(prisma, 'c1')).toEqual({ id: 'conn_1' });
  });

  it('sin id y con VARIOS locales devuelve null: no elige por él', async () => {
    state.connectionFindMany.mockResolvedValue([{ id: 'conn_1' }, { id: 'conn_2' }]);
    expect(await resolveReviewConnection(prisma, 'c1')).toBeNull();
  });

  it('sin ningún local devuelve null', async () => {
    expect(await resolveReviewConnection(prisma, 'c1')).toBeNull();
  });

  it('solo pide dos: le basta para saber si hay más de uno', async () => {
    await resolveReviewConnection(prisma, 'c1');
    expect(state.connectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2, where: { clientId: 'c1', status: 'active' } }),
    );
  });
});

describe('listReviewLocations', () => {
  it('ordena por nombre, para que el selector no se mueva bajo el dedo', async () => {
    await listReviewLocations(prisma, 'c1');
    expect(state.connectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { clientId: 'c1', status: { not: 'revoked' } },
        orderBy: [{ locationName: 'asc' }, { locationId: 'asc' }],
      }),
    );
  });
});
