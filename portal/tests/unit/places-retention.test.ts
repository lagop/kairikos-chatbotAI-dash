// =============================================================================
// 26/10/2026 — caducidad del contenido de Google Places (lib/places-retention.ts).
//
// Lo que se fija:
//
// 1. Qué se purga: solo lo que vino de Places, pasados 30 días, y solo de
//    prospectos sin relación nuestra.
// 2. La huella del teléfono: la misma regla de 9 cifras que phonesMatch, para
//    que una baja purgada siga bloqueando el número.
// 3. El barrido: coordenadas de todos, contenido de los no tocados, fotos de
//    la zona; y lo ya purgado no vuelve a entrar.
// 4. El refresco: vuelve a guardar con ventana nueva, no gasta dos veces en
//    una hora, no pisa la huella si Google ya no da el número, y no guarda
//    nada de un negocio cerrado.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getPlaceDetailsMock = vi.fn();
vi.mock('@/lib/google-places', () => ({
  getPlaceDetails: (...args: unknown[]) => getPlaceDetailsMock(...args),
}));

import {
  PLACES_RETENTION_DAYS,
  DAILY_REFRESH_CAP,
  hasOwnRelationship,
  phoneHashOf,
  phoneMatchesHash,
  placesSummary,
  purgeExpiredPlacesContent,
  refreshLeadFromPlaces,
  resetPlacesRefreshState,
  retentionCutoff,
  shouldPurgePlacesContent,
  type RetentionLeadState,
} from '@/lib/places-retention';

const NOW = new Date('2026-10-26T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function lead(over: Partial<RetentionLeadState> = {}): RetentionLeadState {
  return {
    externalPlaceId: 'ChIJ-test',
    placesFetchedAt: new Date(NOW.getTime() - 31 * DAY),
    placesPurgedAt: null,
    createdAt: new Date(NOW.getTime() - 40 * DAY),
    contactedAt: null,
    repliedAt: null,
    conversationId: null,
    convertedAt: null,
    lastAutoContactAt: null,
    followUpCount: 0,
    ...over,
  };
}

describe('qué se purga', () => {
  it('purga el contenido de Places de un prospecto sin tocar pasados 30 días', () => {
    expect(shouldPurgePlacesContent(lead(), NOW)).toBe(true);
  });

  it('no purga dentro de los 30 días', () => {
    expect(shouldPurgePlacesContent(lead({ placesFetchedAt: new Date(NOW.getTime() - 29 * DAY) }), NOW)).toBe(false);
  });

  it('sin fecha de traída, cuenta desde la creación', () => {
    expect(shouldPurgePlacesContent(lead({ placesFetchedAt: null }), NOW)).toBe(true);
    expect(
      shouldPurgePlacesContent(lead({ placesFetchedAt: null, createdAt: new Date(NOW.getTime() - 5 * DAY) }), NOW),
    ).toBe(false);
  });

  it('no toca lo que no vino de Places ni lo ya purgado', () => {
    expect(shouldPurgePlacesContent(lead({ externalPlaceId: null }), NOW)).toBe(false);
    expect(shouldPurgePlacesContent(lead({ placesPurgedAt: new Date(NOW.getTime() - DAY) }), NOW)).toBe(false);
  });

  it('con relación nuestra no se purga: ya no es una copia de Google', () => {
    const cases: Partial<RetentionLeadState>[] = [
      { contactedAt: NOW },
      { repliedAt: NOW },
      { conversationId: 'conv-1' },
      { convertedAt: NOW },
      { lastAutoContactAt: NOW },
      { followUpCount: 1 },
    ];
    for (const c of cases) {
      expect(hasOwnRelationship(lead(c))).toBe(true);
      expect(shouldPurgePlacesContent(lead(c), NOW)).toBe(false);
    }
  });

  it('la ventana es de 30 días', () => {
    expect(PLACES_RETENTION_DAYS).toBe(30);
    expect(retentionCutoff(NOW).getTime()).toBe(NOW.getTime() - 30 * DAY);
  });
});

describe('huella del teléfono', () => {
  it('el mismo número en formato internacional y nacional da la misma huella', () => {
    expect(phoneHashOf('+34 692 27 13 85')).toBe(phoneHashOf('692271385'));
    expect(phoneMatchesHash('34692271385', phoneHashOf('692 27 13 85'))).toBe(true);
  });

  it('números cortos o vacíos no dan huella, y no casan con nada', () => {
    expect(phoneHashOf('12345')).toBeNull();
    expect(phoneHashOf(null)).toBeNull();
    expect(phoneMatchesHash('692271385', null)).toBe(false);
    expect(phoneMatchesHash('692271386', phoneHashOf('692271385'))).toBe(false);
  });

  it('la huella no contiene el número', () => {
    expect(phoneHashOf('692271385')).not.toContain('692271385');
  });
});

describe('purgeExpiredPlacesContent', () => {
  function fakePrisma(batches: Array<Array<{ id: string; contactPhone: string | null; phoneHash: string | null }>>) {
    const queue = [...batches];
    return {
      lead: {
        updateMany: vi.fn().mockResolvedValue({ count: 3 }),
        findMany: vi.fn(async () => queue.shift() ?? []),
        update: vi.fn().mockResolvedValue({}),
      },
      prospectingCompetitorSnapshot: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    };
  }

  it('borra coordenadas, purga los no tocados con su huella y vacía las fotos', async () => {
    const prisma = fakePrisma([[{ id: 'l1', contactPhone: '+34 692 27 13 85', phoneHash: null }]]);
    const result = await purgeExpiredPlacesContent(prisma as never, NOW);

    expect(result).toEqual({ coordinatesCleared: 3, leadsPurged: 1, snapshotsPurged: 2 });
    expect(prisma.lead.updateMany.mock.calls[0][0].data).toEqual({ latitude: null, longitude: null });

    const findWhere = prisma.lead.findMany.mock.calls[0][0].where;
    // Solo los que nadie ha tocado.
    expect(findWhere).toMatchObject({
      source: 'outbound',
      placesPurgedAt: null,
      contactedAt: null,
      repliedAt: null,
      conversationId: null,
      convertedAt: null,
      lastAutoContactAt: null,
      followUpCount: 0,
    });

    const data = prisma.lead.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      contactName: null,
      contactPhone: null,
      website: null,
      summary: null,
      primaryType: null,
      latitude: null,
      longitude: null,
      placesPurgedAt: NOW,
    });
    expect(data.phoneHash).toBe(phoneHashOf('692271385'));

    const snapWhere = prisma.prospectingCompetitorSnapshot.updateMany.mock.calls[0][0];
    expect(snapWhere.where).toEqual({ capturedAt: { lt: retentionCutoff(NOW) }, purgedAt: null });
    expect(snapWhere.data).toMatchObject({ subjectRating: null, subjectReviewCount: null, competitors: [], purgedAt: NOW });
  });

  it('conserva una huella que ya existía', async () => {
    const prisma = fakePrisma([[{ id: 'l1', contactPhone: null, phoneHash: 'huella-previa' }]]);
    await purgeExpiredPlacesContent(prisma as never, NOW);
    expect(prisma.lead.update.mock.calls[0][0].data.phoneHash).toBe('huella-previa');
  });

  it('sin nada caducado no escribe ningún lead', async () => {
    const prisma = fakePrisma([[]]);
    const result = await purgeExpiredPlacesContent(prisma as never, NOW);
    expect(result.leadsPurged).toBe(0);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});

describe('refreshLeadFromPlaces', () => {
  beforeEach(() => {
    resetPlacesRefreshState();
    getPlaceDetailsMock.mockReset();
  });

  const details = {
    ok: true,
    data: {
      id: 'ChIJ-test',
      name: 'Fontanería Suárez',
      formattedAddress: 'C. Camelia, 50, 35010 Las Palmas de Gran Canaria',
      websiteUri: null,
      phoneNumber: '+34 692 27 13 85',
      primaryType: 'plumber',
      businessStatus: 'OPERATIONAL',
      latitude: 28.1,
      longitude: -15.4,
    },
  };

  it('guarda lo fresco con una ventana nueva y quita la marca de purgado', async () => {
    getPlaceDetailsMock.mockResolvedValue(details);
    const update = vi.fn().mockResolvedValue({});
    const fresh = await refreshLeadFromPlaces({ lead: { update } } as never, { id: 'l1', externalPlaceId: 'ChIJ-test' }, NOW);

    expect(fresh).toMatchObject({ contactName: 'Fontanería Suárez', contactPhone: '+34 692 27 13 85', summary: placesSummary(details.data.formattedAddress) });
    const data = update.mock.calls[0][0].data;
    expect(data.placesFetchedAt).toEqual(NOW);
    expect(data.placesPurgedAt).toBeNull();
    expect(data.phoneHash).toBe(phoneHashOf('692271385'));
  });

  it('no paga dos veces el mismo negocio en una hora', async () => {
    getPlaceDetailsMock.mockResolvedValue(details);
    const prisma = { lead: { update: vi.fn().mockResolvedValue({}) } } as never;
    await refreshLeadFromPlaces(prisma, { id: 'l1', externalPlaceId: 'ChIJ-test' }, NOW);
    await refreshLeadFromPlaces(prisma, { id: 'l1', externalPlaceId: 'ChIJ-test' }, new Date(NOW.getTime() + 30 * 60 * 1000));
    expect(getPlaceDetailsMock).toHaveBeenCalledTimes(1);
  });

  it('si Google ya no da el número, no borra la huella que hubiera', async () => {
    getPlaceDetailsMock.mockResolvedValue({ ...details, data: { ...details.data, phoneNumber: null } });
    const update = vi.fn().mockResolvedValue({});
    await refreshLeadFromPlaces({ lead: { update } } as never, { id: 'l1', externalPlaceId: 'ChIJ-test' }, NOW);
    expect('phoneHash' in update.mock.calls[0][0].data).toBe(false);
  });

  it('de un negocio cerrado para siempre no guarda nada', async () => {
    getPlaceDetailsMock.mockResolvedValue({ ...details, data: { ...details.data, businessStatus: 'CLOSED_PERMANENTLY' } });
    const update = vi.fn();
    const fresh = await refreshLeadFromPlaces({ lead: { update } } as never, { id: 'l1', externalPlaceId: 'ChIJ-test' }, NOW);
    expect(fresh).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it('sin place ID, error de Google o tope agotado devuelve null sin lanzar', async () => {
    const prisma = { lead: { update: vi.fn() } } as never;
    expect(await refreshLeadFromPlaces(prisma, { id: 'l1', externalPlaceId: null }, NOW)).toBeNull();

    getPlaceDetailsMock.mockResolvedValue({ ok: false, error: 'boom' });
    expect(await refreshLeadFromPlaces(prisma, { id: 'l2', externalPlaceId: 'otro' }, NOW)).toBeNull();

    resetPlacesRefreshState();
    getPlaceDetailsMock.mockResolvedValue(details);
    for (let i = 0; i < DAILY_REFRESH_CAP; i += 1) {
      await refreshLeadFromPlaces(prisma, { id: `l${i}`, externalPlaceId: `place-${i}` }, NOW);
    }
    getPlaceDetailsMock.mockClear();
    expect(await refreshLeadFromPlaces(prisma, { id: 'extra', externalPlaceId: 'place-extra' }, NOW)).toBeNull();
    expect(getPlaceDetailsMock).not.toHaveBeenCalled();
  });
});
