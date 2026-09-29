// =============================================================================
// Varias búsquedas por campaña de prospección (29/09/2026) — lib/prospecting.ts.
//
// Lo que se fija aquí: el tope del mes es de la CAMPAÑA y se reparte entre
// sus búsquedas, empieza la menos atendida, se pagina para no quedarse en los
// mismos 20 resultados, y un negocio que sale en dos búsquedas no se paga dos
// veces. La invariante de cobro de siempre (cada Place Details cuenta) la
// sigue fijando prospecting.test.ts.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const mockState = vi.hoisted(() => ({
  isGooglePlacesConfigured: vi.fn(),
  searchPlaces: vi.fn(),
  getPlaceDetails: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/google-places', () => ({
  isGooglePlacesConfigured: () => mockState.isGooglePlacesConfigured(),
  searchPlaces: (...a: unknown[]) => mockState.searchPlaces(...a),
  getPlaceDetails: (...a: unknown[]) => mockState.getPlaceDetails(...a),
}));

vi.mock('@/lib/observability', () => ({
  logError: (...a: unknown[]) => mockState.logError(...a),
}));

import {
  runProspectingSearch,
  MAX_PAGES_PER_SEARCH,
  MAX_SEARCHES_PER_CAMPAIGN,
  normalizeSearches,
  diffSearches,
  searchKey,
  type ProspectingCampaignInput,
  type ProspectingSearchInput,
} from '@/lib/prospecting';

const state = {
  leadFindMany: vi.fn(),
  leadCreate: vi.fn(),
  leadAuditCreate: vi.fn(),
  campaignUpdate: vi.fn(),
  searchUpdate: vi.fn(),
};

const mockTx = {
  lead: { create: (...a: unknown[]) => state.leadCreate(...a) },
  leadAudit: { create: (...a: unknown[]) => state.leadAuditCreate(...a) },
};

const prisma = {
  $transaction: (fn: (tx: typeof mockTx) => unknown) => fn(mockTx),
  lead: { findMany: (...a: unknown[]) => state.leadFindMany(...a) },
  prospectingCampaign: { update: (...a: unknown[]) => state.campaignUpdate(...a) },
  prospectingSearch: { update: (...a: unknown[]) => state.searchUpdate(...a) },
} as unknown as PrismaClient;

const NOW = new Date('2026-09-29T10:00:00.000Z');

function search(id: string, category: string, lastRunAt: Date | null = null): ProspectingSearchInput {
  return { id, category, locationQuery: 'Madrid', lastRunAt };
}

function campaign(over: Partial<ProspectingCampaignInput> = {}): ProspectingCampaignInput {
  return {
    id: 'campaign_1',
    clientId: 'client_1',
    tenantId: 't1',
    searches: [search('s1', 'reformas')],
    leadsFoundThisMonth: 0,
    monthlyLeadCap: 100,
    usageResetAt: new Date('2026-09-01T00:00:00.000Z'),
    alertedAt: null,
    ...over,
  };
}

function details(id: string) {
  return {
    ok: true as const,
    data: {
      id,
      name: `Negocio ${id}`,
      formattedAddress: `Dirección de ${id}`,
      websiteUri: null,
      phoneNumber: '+34910000000',
      primaryType: 'store',
      businessStatus: 'OPERATIONAL',
      latitude: null,
      longitude: null,
    },
  };
}

/** searchPlaces según la consulta: cada búsqueda devuelve sus propias
 *  páginas, y el token dice qué página toca ('tok:2' → la tercera). */
function placesByQuery(pages: Record<string, Array<{ ids: string[]; next?: string }>>) {
  mockState.searchPlaces.mockImplementation(
    ({ textQuery, pageToken }: { textQuery: string; pageToken?: string }) => {
      const list = pages[textQuery] ?? [];
      const page = list[pageToken ? Number(pageToken.split(':')[1]) : 0];
      if (!page) return Promise.resolve({ ok: true, data: { results: [], nextPageToken: null } });
      return Promise.resolve({
        ok: true,
        data: {
          results: page.ids.map((id) => ({ id, name: id, formattedAddress: null, websiteUri: null, types: [] })),
          nextPageToken: page.next ?? null,
        },
      });
    },
  );
}

/** Lead.findMany de la deduplicación: ya guardados, los que empiezan por «viejo». */
function alreadySaved(predicate: (id: string) => boolean) {
  state.leadFindMany.mockImplementation(({ where }: { where: { externalPlaceId: { in: string[] } } }) =>
    Promise.resolve(where.externalPlaceId.in.filter(predicate).map((id) => ({ externalPlaceId: id }))),
  );
}

const detailsCalls = () => mockState.getPlaceDetails.mock.calls.map((c) => c[0] as string);
const queries = () => mockState.searchPlaces.mock.calls.map((c) => (c[0] as { textQuery: string }).textQuery);

beforeEach(() => {
  for (const fn of Object.values(mockState)) fn.mockReset();
  for (const fn of Object.values(state)) fn.mockReset();
  mockState.isGooglePlacesConfigured.mockReturnValue(true);
  mockState.getPlaceDetails.mockImplementation((id: string) => Promise.resolve(details(id)));
  state.leadFindMany.mockResolvedValue([]);
  state.leadCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: `lead_${String(data.externalPlaceId)}`, ...data }),
  );
  state.campaignUpdate.mockResolvedValue({});
  state.searchUpdate.mockResolvedValue({});
});

describe('el tope del mes se reparte entre las búsquedas', () => {
  it('cada búsqueda recibe su parte, y cada lead guarda la búsqueda que lo encontró', async () => {
    placesByQuery({
      'reformas en Madrid': [{ ids: ['a1', 'a2', 'a3', 'a4'] }],
      'fincas en Madrid': [{ ids: ['b1', 'b2', 'b3', 'b4'] }],
    });

    const result = await runProspectingSearch(
      prisma,
      campaign({
        searches: [search('s1', 'reformas'), search('s2', 'fincas')],
        leadsFoundThisMonth: 96,
        monthlyLeadCap: 100,
      }),
      NOW,
    );

    expect(detailsCalls()).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(result).toMatchObject({ ok: true, created: 4, searchesRun: 2, capReached: true });
    const found = state.leadCreate.mock.calls.map(
      (c) => (c[0] as { data: { searchCategory: string; searchLocation: string } }).data,
    );
    expect(found.map((d) => d.searchCategory)).toEqual(['reformas', 'reformas', 'fincas', 'fincas']);
    expect(found.every((d) => d.searchLocation === 'Madrid')).toBe(true);
  });

  it('lo que una búsqueda no gasta pasa a las siguientes', async () => {
    placesByQuery({
      'reformas en Madrid': [{ ids: ['a1'] }],
      'fincas en Madrid': [{ ids: ['b1', 'b2', 'b3'] }],
    });
    await runProspectingSearch(
      prisma,
      campaign({
        searches: [search('s1', 'reformas'), search('s2', 'fincas')],
        leadsFoundThisMonth: 96,
        monthlyLeadCap: 100,
      }),
      NOW,
    );
    // reformas solo encontró 1 de sus 2: fincas recibe los 3 que quedan.
    expect(detailsCalls()).toEqual(['a1', 'b1', 'b2', 'b3']);
  });

  it('el contador del mes suma las fichas de todas las búsquedas', async () => {
    placesByQuery({ 'reformas en Madrid': [{ ids: ['a1'] }], 'fincas en Madrid': [{ ids: ['b1', 'b2'] }] });
    await runProspectingSearch(
      prisma,
      campaign({ searches: [search('s1', 'reformas'), search('s2', 'fincas')], leadsFoundThisMonth: 10 }),
      NOW,
    );
    expect(state.campaignUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ leadsFoundThisMonth: 13, lastRunAt: NOW }) }),
    );
  });

  it('con el tope agotado a mitad de pasada, las que quedan ni se consultan ni se dan por atendidas', async () => {
    placesByQuery({ 'reformas en Madrid': [{ ids: ['a1', 'a2'] }], 'fincas en Madrid': [{ ids: ['b1'] }] });
    await runProspectingSearch(
      prisma,
      campaign({
        searches: [search('s1', 'reformas', null), search('s2', 'fincas', new Date('2026-09-10T00:00:00Z'))],
        leadsFoundThisMonth: 99,
        monthlyLeadCap: 100,
      }),
      NOW,
    );
    expect(queries()).toEqual(['reformas en Madrid']);
    expect(state.searchUpdate).toHaveBeenCalledTimes(1);
    expect(state.searchUpdate).toHaveBeenCalledWith({ where: { id: 's1' }, data: { lastRunAt: NOW } });
  });
});

describe('el orden', () => {
  it('empieza por la búsqueda que lleva más tiempo sin atender; las nuevas, antes que ninguna', async () => {
    placesByQuery({});
    await runProspectingSearch(
      prisma,
      campaign({
        searches: [
          search('reciente', 'reformas', new Date('2026-09-20T00:00:00Z')),
          search('antigua', 'fincas', new Date('2026-09-01T00:00:00Z')),
          search('nueva', 'hoteles', null),
        ],
      }),
      NOW,
    );
    expect(queries()).toEqual(['hoteles en Madrid', 'fincas en Madrid', 'reformas en Madrid']);
  });
});

describe('la paginación', () => {
  // Hasta el 29/09/2026 se pedía una sola página: la segunda semana volvían
  // los mismos 20 negocios, ya guardados, y el barrido no encontraba nada.
  it('si la primera página ya está toda guardada, pasa a la siguiente', async () => {
    placesByQuery({
      'reformas en Madrid': [{ ids: ['viejo1', 'viejo2'], next: 'tok:1' }, { ids: ['nuevo1'] }],
    });
    alreadySaved((id) => id.startsWith('viejo'));

    const result = await runProspectingSearch(prisma, campaign(), NOW);

    expect(mockState.searchPlaces).toHaveBeenCalledTimes(2);
    expect(mockState.searchPlaces.mock.calls[1][0]).toMatchObject({ pageToken: 'tok:1' });
    expect(detailsCalls()).toEqual(['nuevo1']);
    expect(result).toMatchObject({ ok: true, created: 1 });
  });

  it(`nunca pide más de ${MAX_PAGES_PER_SEARCH} páginas por búsqueda`, async () => {
    placesByQuery({
      'reformas en Madrid': Array.from({ length: 6 }, (_, i) => ({ ids: [`viejo${i}`], next: `tok:${i + 1}` })),
    });
    alreadySaved(() => true);
    await runProspectingSearch(prisma, campaign(), NOW);
    expect(mockState.searchPlaces).toHaveBeenCalledTimes(MAX_PAGES_PER_SEARCH);
  });

  it('no pide la página siguiente si ya tiene los que le tocan: cada página es una llamada', async () => {
    placesByQuery({ 'reformas en Madrid': [{ ids: ['a1', 'a2'], next: 'tok:1' }, { ids: ['a3'] }] });
    await runProspectingSearch(prisma, campaign({ leadsFoundThisMonth: 98, monthlyLeadCap: 100 }), NOW);
    expect(mockState.searchPlaces).toHaveBeenCalledTimes(1);
  });

  it('si falla la segunda página, se queda con lo que dio la primera', async () => {
    mockState.searchPlaces
      .mockResolvedValueOnce({
        ok: true,
        data: { results: [{ id: 'a1', name: 'a1', formattedAddress: null, websiteUri: null, types: [] }], nextPageToken: 'tok:1' },
      })
      .mockResolvedValueOnce({ ok: false, error: 'boom' });
    const result = await runProspectingSearch(prisma, campaign(), NOW);
    expect(result).toMatchObject({ ok: true, created: 1, searchesRun: 1 });
  });
});

describe('los negocios repetidos entre búsquedas', () => {
  it('uno que sale en dos búsquedas se paga una sola vez', async () => {
    placesByQuery({
      'reformas en Madrid': [{ ids: ['comun', 'a1'] }],
      'fincas en Madrid': [{ ids: ['comun', 'b1'] }],
    });
    const result = await runProspectingSearch(
      prisma,
      campaign({ searches: [search('s1', 'reformas'), search('s2', 'fincas')] }),
      NOW,
    );
    expect(detailsCalls().filter((id) => id === 'comun')).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, detailsCallsMade: 3 });
  });

  it('uno que la primera encontró pero no pudo procesar lo recoge la siguiente', async () => {
    placesByQuery({
      'reformas en Madrid': [{ ids: ['a1', 'a2'] }],
      'fincas en Madrid': [{ ids: ['a2'] }],
    });
    await runProspectingSearch(
      prisma,
      campaign({
        searches: [search('s1', 'reformas'), search('s2', 'fincas')],
        leadsFoundThisMonth: 98,
        monthlyLeadCap: 100,
      }),
      NOW,
    );
    expect(detailsCalls()).toEqual(['a1', 'a2']);
  });
});

describe('los fallos', () => {
  it('si falla una búsqueda, las demás siguen; la que falló no se da por atendida', async () => {
    mockState.searchPlaces.mockImplementation(({ textQuery }: { textQuery: string }) =>
      Promise.resolve(
        textQuery.startsWith('reformas')
          ? { ok: false, error: 'boom' }
          : {
              ok: true,
              data: {
                results: [{ id: 'b1', name: 'b1', formattedAddress: null, websiteUri: null, types: [] }],
                nextPageToken: null,
              },
            },
      ),
    );

    const result = await runProspectingSearch(
      prisma,
      campaign({ searches: [search('s1', 'reformas'), search('s2', 'fincas')] }),
      NOW,
    );

    expect(result).toMatchObject({ ok: true, created: 1, searchesRun: 1 });
    expect(state.searchUpdate).toHaveBeenCalledWith({ where: { id: 's2' }, data: { lastRunAt: NOW } });
    expect(state.searchUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's1' } }));
  });

  it('si fallan todas, search_failed y la campaña no se da por atendida', async () => {
    mockState.searchPlaces.mockResolvedValue({ ok: false, error: 'API key not valid' });
    const result = await runProspectingSearch(
      prisma,
      campaign({ searches: [search('s1', 'reformas'), search('s2', 'fincas')] }),
      NOW,
    );
    expect(result).toEqual({ ok: false, error: 'search_failed' });
    expect(state.campaignUpdate).not.toHaveBeenCalled();
    expect(state.searchUpdate).not.toHaveBeenCalled();
  });
});

describe('normalizeSearches', () => {
  it('recorta, junta espacios, descarta las incompletas y quita las repetidas (se queda la primera)', () => {
    expect(
      normalizeSearches([
        { category: '  reformas  de baños ', locationQuery: 'Madrid ' },
        { category: 'Reformas de baños', locationQuery: 'madrid' },
        { category: '', locationQuery: 'Toledo' },
        { category: 'fincas', locationQuery: '   ' },
        { category: 'fincas', locationQuery: 'Madrid' },
      ]),
    ).toEqual([
      { category: 'reformas de baños', locationQuery: 'Madrid' },
      { category: 'fincas', locationQuery: 'Madrid' },
    ]);
  });

  it('searchKey ignora mayúsculas y espacios, no el contenido', () => {
    expect(searchKey({ category: 'Reformas', locationQuery: 'Madrid' })).toBe(
      searchKey({ category: ' reformas ', locationQuery: 'MADRID' }),
    );
    expect(searchKey({ category: 'reformas', locationQuery: 'Madrid' })).not.toBe(
      searchKey({ category: 'reformas', locationQuery: 'Móstoles' }),
    );
  });

  it('el techo de búsquedas es razonable frente a las 10.000 llamadas gratis al mes', () => {
    // 4,3 barridos al mes × páginas × búsquedas, por campaña. Si esto sube,
    // hay que revisar docs/costes-y-topes.md.
    expect(Math.ceil(4.3 * MAX_PAGES_PER_SEARCH * MAX_SEARCHES_PER_CAMPAIGN)).toBeLessThanOrEqual(130);
  });
});

describe('diffSearches', () => {
  const existing = [
    { id: 'a', category: 'reformas', locationQuery: 'Madrid' },
    { id: 'b', category: 'fincas', locationQuery: 'Madrid' },
  ];

  // Recrearlas en cada guardado perdería su lastRunAt, que decide a quién
  // atiende primero el barrido.
  it('conserva las que siguen, borra las que faltan y crea las nuevas', () => {
    expect(
      diffSearches(existing, [
        { category: 'reformas', locationQuery: 'Madrid' },
        { category: 'hoteles', locationQuery: 'Madrid' },
      ]),
    ).toEqual({ deleteIds: ['b'], create: [{ category: 'hoteles', locationQuery: 'Madrid' }], update: [] });
  });

  it('la misma búsqueda escrita de otra forma se corrige sin perder la fila', () => {
    expect(diffSearches(existing, [{ category: 'Reformas', locationQuery: 'Madrid' }, existing[1]])).toEqual({
      deleteIds: [],
      create: [],
      update: [{ id: 'a', category: 'Reformas', locationQuery: 'Madrid' }],
    });
  });

  it('sin cambios, no hay nada que hacer', () => {
    expect(diffSearches(existing, existing)).toEqual({ deleteIds: [], create: [], update: [] });
  });
});
