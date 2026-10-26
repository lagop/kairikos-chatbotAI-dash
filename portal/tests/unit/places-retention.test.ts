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
  CLIENT_DAILY_REFRESH_CAP,
  GLOBAL_DAILY_REFRESH_CAP,
  isPlaceGone,
  refreshExpiredLeadsForClient,
  refreshHttpStatus,
  refreshLeadPlacesData,
  refreshResultMessage,
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

// -----------------------------------------------------------------------------
// «Actualizar desde Google»
// -----------------------------------------------------------------------------

const DETAILS = {
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

function refreshPrisma(opts: { lead?: object | null; clientCount?: number; globalCount?: number } = {}) {
  const lead =
    opts.lead === undefined
      ? { id: 'l1', clientId: 'c1', tenantId: null, externalPlaceId: 'ChIJ-test', status: 'nuevo' }
      : opts.lead;
  return {
    lead: {
      findFirst: vi.fn().mockResolvedValue(lead),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    leadAudit: {
      // Primero el del cliente (lleva clientId), luego el global.
      count: vi.fn(async (args: { where: { clientId?: string } }) =>
        args.where.clientId ? (opts.clientCount ?? 0) : (opts.globalCount ?? 0),
      ),
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

describe('refreshLeadPlacesData', () => {
  beforeEach(() => {
    resetPlacesRefreshState();
    getPlaceDetailsMock.mockReset();
  });

  it('el lead tiene que ser del cliente: el clientId va en la consulta y uno ajeno es «no encontrado»', async () => {
    const prisma = refreshPrisma({ lead: null });
    const result = await refreshLeadPlacesData(prisma as never, { leadId: 'l1', clientId: 'c2', actorId: 'client:c2', now: NOW });
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: 'l1', clientId: 'c2' });
    expect(result).toEqual({ ok: false, reason: 'lead_not_found' });
    expect(getPlaceDetailsMock).not.toHaveBeenCalled();
    expect(refreshHttpStatus(result)).toBe(404);
  });

  it('el operador no filtra por cliente', async () => {
    getPlaceDetailsMock.mockResolvedValue(DETAILS);
    const prisma = refreshPrisma();
    await refreshLeadPlacesData(prisma as never, { leadId: 'l1', actorId: 'op-1', now: NOW });
    expect(prisma.lead.findFirst.mock.calls[0][0].where).toEqual({ id: 'l1' });
  });

  it('guarda lo fresco, reabre los 30 días, quita las marcas y deja auditoría', async () => {
    getPlaceDetailsMock.mockResolvedValue(DETAILS);
    const prisma = refreshPrisma();
    const result = await refreshLeadPlacesData(prisma as never, { leadId: 'l1', clientId: 'c1', actorId: 'client:c1', now: NOW });

    expect(result).toMatchObject({ ok: true, fromCache: false, fields: { contactName: 'Fontanería Suárez', summary: placesSummary(DETAILS.data.formattedAddress) } });
    const data = prisma.lead.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ placesFetchedAt: NOW, placesPurgedAt: null, placesUnavailable: null, phoneHash: phoneHashOf('692271385') });
    expect(prisma.leadAudit.create.mock.calls[0][0].data).toMatchObject({ leadId: 'l1', clientId: 'c1', action: 'places_refreshed', actorId: 'client:c1' });
    expect(refreshResultMessage(result)).toBe('Datos actualizados desde Google.');
  });

  it('no paga dos veces el mismo negocio en una hora', async () => {
    getPlaceDetailsMock.mockResolvedValue(DETAILS);
    const prisma = refreshPrisma();
    await refreshLeadPlacesData(prisma as never, { leadId: 'l1', actorId: 'op', now: NOW });
    const again = await refreshLeadPlacesData(prisma as never, { leadId: 'l1', actorId: 'op', now: new Date(NOW.getTime() + 30 * 60 * 1000) });
    expect(again).toMatchObject({ ok: true, fromCache: true });
    expect(getPlaceDetailsMock).toHaveBeenCalledTimes(1);
    expect(prisma.leadAudit.create).toHaveBeenCalledTimes(1);
  });

  it('al llegar al tope del cliente no llama a Google y lo dice', async () => {
    const prisma = refreshPrisma({ clientCount: CLIENT_DAILY_REFRESH_CAP });
    const result = await refreshLeadPlacesData(prisma as never, { leadId: 'l1', clientId: 'c1', actorId: 'client:c1', now: NOW });
    expect(result).toEqual({ ok: false, reason: 'client_cap' });
    expect(getPlaceDetailsMock).not.toHaveBeenCalled();
    expect(refreshHttpStatus(result)).toBe(429);
    expect(refreshResultMessage(result)).toContain(`tope de ${CLIENT_DAILY_REFRESH_CAP}`);
  });

  it('el tope global manda sobre el del cliente', async () => {
    const prisma = refreshPrisma({ globalCount: GLOBAL_DAILY_REFRESH_CAP });
    const result = await refreshLeadPlacesData(prisma as never, { leadId: 'l1', actorId: 'op', now: NOW });
    expect(result).toEqual({ ok: false, reason: 'global_cap' });
    expect(getPlaceDetailsMock).not.toHaveBeenCalled();
  });

  it('los topes se cuentan en LeadAudit desde el inicio del día', async () => {
    getPlaceDetailsMock.mockResolvedValue(DETAILS);
    const prisma = refreshPrisma();
    await refreshLeadPlacesData(prisma as never, { leadId: 'l1', actorId: 'op', now: NOW });
    const where = prisma.leadAudit.count.mock.calls[0][0].where;
    expect(where.action).toEqual({ in: ['places_refreshed', 'places_unavailable'] });
    expect(where.changedAt).toEqual({ gte: new Date('2026-10-26T00:00:00Z') });
  });

  it('si Google ya no encuentra el negocio, lo guarda y lo dice en vez de fallar en silencio', async () => {
    getPlaceDetailsMock.mockResolvedValue({ ok: false, error: 'Place not found', status: 404 });
    const prisma = refreshPrisma();
    const result = await refreshLeadPlacesData(prisma as never, { leadId: 'l1', actorId: 'op', now: NOW });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(prisma.lead.update.mock.calls[0][0].data).toEqual({ placesUnavailable: 'not_found' });
    expect(prisma.leadAudit.create.mock.calls[0][0].data.action).toBe('places_unavailable');
    expect(refreshResultMessage(result)).toContain('ya no encuentra');
    expect(refreshHttpStatus(result)).toBe(409);
  });

  it('un negocio cerrado definitivamente se marca como tal y no se guardan sus datos', async () => {
    getPlaceDetailsMock.mockResolvedValue({ ...DETAILS, data: { ...DETAILS.data, businessStatus: 'CLOSED_PERMANENTLY' } });
    const prisma = refreshPrisma();
    const result = await refreshLeadPlacesData(prisma as never, { leadId: 'l1', actorId: 'op', now: NOW });
    expect(result).toEqual({ ok: false, reason: 'closed' });
    expect(prisma.lead.update.mock.calls[0][0].data).toEqual({ placesUnavailable: 'closed' });
  });

  it('un error pasajero de Google no marca nada ni cuenta para el tope', async () => {
    getPlaceDetailsMock.mockResolvedValue({ ok: false, error: 'boom', status: 500 });
    const prisma = refreshPrisma();
    const result = await refreshLeadPlacesData(prisma as never, { leadId: 'l1', actorId: 'op', now: NOW });
    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.leadAudit.create).not.toHaveBeenCalled();
  });

  it('si Google ya no da el número, no borra la huella que hubiera', async () => {
    getPlaceDetailsMock.mockResolvedValue({ ...DETAILS, data: { ...DETAILS.data, phoneNumber: null } });
    const prisma = refreshPrisma();
    await refreshLeadPlacesData(prisma as never, { leadId: 'l1', actorId: 'op', now: NOW });
    expect('phoneHash' in prisma.lead.update.mock.calls[0][0].data).toBe(false);
  });

  it('sin place ID no hay nada que pedir', async () => {
    const prisma = refreshPrisma({ lead: { id: 'l1', clientId: 'c1', tenantId: null, externalPlaceId: null, status: 'nuevo' } });
    expect(await refreshLeadPlacesData(prisma as never, { leadId: 'l1', actorId: 'op', now: NOW })).toEqual({ ok: false, reason: 'no_place_id' });
  });

  it('isPlaceGone: 404, o 400 de un ID retirado; nada más', () => {
    expect(isPlaceGone(404, 'x')).toBe(true);
    expect(isPlaceGone(400, 'Not found: place id')).toBe(true);
    expect(isPlaceGone(400, 'quota exceeded')).toBe(false);
    expect(isPlaceGone(500, 'not found')).toBe(false);
    expect(isPlaceGone(undefined, 'network')).toBe(false);
  });
});

describe('refreshLeadFromPlaces (lista diaria e informe)', () => {
  beforeEach(() => {
    resetPlacesRefreshState();
    getPlaceDetailsMock.mockReset();
  });

  it('devuelve los datos frescos o null', async () => {
    getPlaceDetailsMock.mockResolvedValue(DETAILS);
    expect(await refreshLeadFromPlaces(refreshPrisma() as never, { id: 'l1', externalPlaceId: 'ChIJ-test' }, NOW)).toMatchObject({
      contactPhone: '+34 692 27 13 85',
    });
    resetPlacesRefreshState();
    getPlaceDetailsMock.mockResolvedValue({ ok: false, error: 'boom', status: 500 });
    expect(await refreshLeadFromPlaces(refreshPrisma() as never, { id: 'l1', externalPlaceId: 'ChIJ-test' }, NOW)).toBeNull();
    expect(await refreshLeadFromPlaces(refreshPrisma() as never, { id: 'l1', externalPlaceId: null }, NOW)).toBeNull();
  });
});

describe('refreshExpiredLeadsForClient', () => {
  beforeEach(() => {
    resetPlacesRefreshState();
    getPlaceDetailsMock.mockReset();
  });

  it('solo los caducados de ese cliente que Google aún encuentra, y se para en el tope', async () => {
    getPlaceDetailsMock.mockResolvedValue(DETAILS);
    const prisma = refreshPrisma();
    prisma.lead.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    // a pasa; en b el cliente ya está en el tope.
    let calls = 0;
    prisma.leadAudit.count.mockImplementation(async (args: { where: { clientId?: string } }) => {
      if (!args.where.clientId) return 0;
      calls += 1;
      return calls === 1 ? 0 : CLIENT_DAILY_REFRESH_CAP;
    });
    prisma.lead.findFirst.mockImplementation(async (args: { where: { id: string } }) => ({
      id: args.where.id,
      clientId: 'c1',
      tenantId: null,
      externalPlaceId: `place-${args.where.id}`,
      status: 'nuevo',
    }));

    const result = await refreshExpiredLeadsForClient(prisma as never, { clientId: 'c1', actorId: 'op', now: NOW });

    expect(prisma.lead.findMany.mock.calls[0][0].where).toEqual({
      clientId: 'c1',
      placesPurgedAt: { not: null },
      externalPlaceId: { not: null },
      placesUnavailable: null,
    });
    expect(result).toEqual({ refreshed: 1, unavailable: 0, failed: 0, stoppedAtCap: true });
    expect(getPlaceDetailsMock).toHaveBeenCalledTimes(1);
  });
});

