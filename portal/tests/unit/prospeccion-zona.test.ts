// =============================================================================
// La foto de zona del gancho público de /prospeccion/.
//
// Lo que se fija aquí es sobre todo DINERO. Es la segunda superficie pública
// que gasta por pulsación, y la lección de la primera —el borrador de web—
// está escrita en su propio lib: sin frenos, un script deja la cuenta seca en
// una tarde.
//
// 1. Que una combinación ya vista NO llame a Google. Es el freno que de
//    verdad acota el gasto, porque las dos listas son cerradas: 572
//    combinaciones, treinta días cada una.
// 2. Que los topes cuenten búsquedas NUEVAS y no peticiones. Negar una que
//    sale de caché no ahorra un céntimo y empeora la página.
// 3. Que con el tope alcanzado se prefiera una foto caducada a un error: una
//    cifra de hace cinco semanas sigue siendo verdad aproximada.
// 4. Que un rubro o una provincia fuera de lista NO lleguen a la llamada de
//    pago. Ese es el freno que hace que el gasto máximo no dependa de lo que
//    escriba nadie.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const buscar = vi.fn();
vi.mock('@/lib/google-places', () => ({
  searchPlaces: (...a: unknown[]) => buscar(...a),
  isGooglePlacesConfigured: async () => true,
}));
vi.mock('@/lib/observability', () => ({ logError: () => {} }));

const { fotoDeZona, consultaPara, esRubroConocido, esProvinciaConocida,
        MAX_BUSQUEDAS_NUEVAS_POR_DIA, MAX_BUSQUEDAS_NUEVAS_POR_IP, PROVINCIAS } =
  await import('@/lib/prospeccion-zona');

const AHORA = new Date('2026-10-02T10:00:00.000Z');
const HACE_DOS_DIAS = new Date('2026-09-30T10:00:00.000Z');
const HACE_CUARENTA_DIAS = new Date('2026-08-23T10:00:00.000Z');

function sitios(conWeb: number, sinWeb: number) {
  return {
    ok: true,
    data: {
      results: [
        ...Array.from({ length: conWeb }, (_, i) => ({ id: `c${i}`, websiteUri: 'https://x.example' })),
        ...Array.from({ length: sinWeb }, (_, i) => ({ id: `s${i}`, websiteUri: null })),
      ],
      nextPageToken: null,
    },
  };
}

function prismaFalso(fila: Record<string, unknown> | null, conteos: { hoy: number; ip: number } = { hoy: 0, ip: 0 }) {
  const upsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({ ...create }));
  return {
    upsert,
    prisma: {
      prospeccionZonaCache: {
        findUnique: async () => fila,
        count: async ({ where }: { where: Record<string, unknown> }) =>
          'ipHash' in where ? conteos.ip : conteos.hoy,
        upsert,
      },
    } as never,
  };
}

const ENTRADA = { rubro: 'fontaneria', provincia: 'Valencia', ipHash: 'abc' };

beforeEach(() => { buscar.mockReset(); });

describe('las dos listas cerradas', () => {
  it('son el freno: lo que no está en ellas no llega a la llamada de pago', async () => {
    const { prisma } = prismaFalso(null);

    const r1 = await fotoDeZona(prisma, { ...ENTRADA, rubro: 'criptomonedas' }, AHORA);
    const r2 = await fotoDeZona(prisma, { ...ENTRADA, provincia: 'Narnia' }, AHORA);

    expect(r1).toEqual({ ok: false, error: 'rubro_desconocido' });
    expect(r2).toEqual({ ok: false, error: 'provincia_desconocida' });
    expect(buscar).not.toHaveBeenCalled();
  });

  it('la consulta a Google se arma SIEMPRE con las listas, no con lo que llegue', () => {
    expect(consultaPara('fontaneria', 'Valencia')).toBe('Fontanería en Valencia');
    expect(esRubroConocido('fontaneria')).toBe(true);
    expect(esRubroConocido('lo que sea')).toBe(false);
    expect(esProvinciaConocida('Valencia')).toBe(true);
    expect(PROVINCIAS).toHaveLength(52);
  });
});

describe('la caché', () => {
  it('una combinación vista hace dos días NO vuelve a llamar a Google', async () => {
    const { prisma } = prismaFalso({ sinWeb: 7, total: 20, miradoEl: HACE_DOS_DIAS });

    const r = await fotoDeZona(prisma, ENTRADA, AHORA);

    expect(r).toEqual({ ok: true, foto: { sinWeb: 7, total: 20, miradoEl: HACE_DOS_DIAS.toISOString(), deCache: true } });
    expect(buscar).not.toHaveBeenCalled();
  });

  it('una de hace cuarenta días sí, porque ha caducado', async () => {
    buscar.mockResolvedValue(sitios(13, 7));
    const { prisma } = prismaFalso({ sinWeb: 2, total: 20, miradoEl: HACE_CUARENTA_DIAS });

    const r = await fotoDeZona(prisma, ENTRADA, AHORA);

    expect(buscar).toHaveBeenCalledOnce();
    expect(r.ok && r.foto.sinWeb).toBe(7);
    expect(r.ok && r.foto.deCache).toBe(false);
  });

  it('guarda la muestra y cuenta como «sin web» al que no tiene websiteUri', async () => {
    buscar.mockResolvedValue(sitios(14, 6));
    const { prisma, upsert } = prismaFalso(null);

    const r = await fotoDeZona(prisma, ENTRADA, AHORA);

    expect(r.ok && r.foto).toMatchObject({ sinWeb: 6, total: 20, deCache: false });
    expect(upsert).toHaveBeenCalledOnce();
  });
});

describe('los topes', () => {
  it('con el tope global alcanzado y sin foto previa, se niega', async () => {
    const { prisma } = prismaFalso(null, { hoy: MAX_BUSQUEDAS_NUEVAS_POR_DIA, ip: 0 });

    const r = await fotoDeZona(prisma, ENTRADA, AHORA);

    expect(r).toEqual({ ok: false, error: 'tope_global' });
    expect(buscar).not.toHaveBeenCalled();
  });

  it('con el tope alcanzado pero con foto caducada, se sirve la vieja', async () => {
    // Una cifra de hace cinco semanas sigue siendo verdad aproximada, y el
    // visitante no se va con las manos vacías por un tope que no es suyo.
    const { prisma } = prismaFalso({ sinWeb: 9, total: 20, miradoEl: HACE_CUARENTA_DIAS },
                                   { hoy: MAX_BUSQUEDAS_NUEVAS_POR_DIA, ip: 0 });

    const r = await fotoDeZona(prisma, ENTRADA, AHORA);

    expect(r.ok && r.foto.sinWeb).toBe(9);
    expect(buscar).not.toHaveBeenCalled();
  });

  it('el tope por IP para el goteo de uno solo', async () => {
    const { prisma } = prismaFalso(null, { hoy: 0, ip: MAX_BUSQUEDAS_NUEVAS_POR_IP });

    expect(await fotoDeZona(prisma, ENTRADA, AHORA)).toEqual({ ok: false, error: 'tope_ip' });
    expect(buscar).not.toHaveBeenCalled();
  });

  it('los topes NO frenan lo que sale de caché', async () => {
    // Si frenaran, el primero del día se llevaría la cifra y el resto vería
    // un error por algo que no cuesta nada.
    const { prisma } = prismaFalso({ sinWeb: 4, total: 20, miradoEl: HACE_DOS_DIAS },
                                   { hoy: MAX_BUSQUEDAS_NUEVAS_POR_DIA, ip: MAX_BUSQUEDAS_NUEVAS_POR_IP });

    const r = await fotoDeZona(prisma, ENTRADA, AHORA);

    expect(r.ok && r.foto.sinWeb).toBe(4);
  });
});

describe('cuando Google falla', () => {
  it('con foto vieja se sirve la vieja; sin ella, error honesto y nunca un cero', async () => {
    buscar.mockResolvedValue({ ok: false, error: 'boom' });

    const conFoto = prismaFalso({ sinWeb: 5, total: 20, miradoEl: HACE_CUARENTA_DIAS });
    const r1 = await fotoDeZona(conFoto.prisma, ENTRADA, AHORA);
    expect(r1.ok && r1.foto.sinWeb).toBe(5);

    const sinFoto = prismaFalso(null);
    const r2 = await fotoDeZona(sinFoto.prisma, ENTRADA, AHORA);
    // Un cero se leería como «no hay competencia», que es lo contrario de
    // lo que pasa.
    expect(r2).toEqual({ ok: false, error: 'error_externo' });
  });

  it('una zona sin resultados se dice, no se inventa', async () => {
    buscar.mockResolvedValue(sitios(0, 0));
    const { prisma } = prismaFalso(null);

    expect(await fotoDeZona(prisma, ENTRADA, AHORA)).toEqual({ ok: false, error: 'sin_resultados' });
  });
});
