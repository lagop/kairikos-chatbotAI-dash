// =============================================================================
// El gancho público de /seo/.
//
// Lo que se fija aquí NO es el dinero: esta superficie no gasta un céntimo. Es
// lo otro, que el dinero tapaba en las dos anteriores:
//
// 1. Que la URL se NORMALICE. Con un campo de texto, «ejemplo.com» y
//    «https://ejemplo.com/?utm_source=x» son la misma web, y si no lo son para
//    la caché entonces la caché no existe: cada anuncio con su utm sería una
//    descarga nueva de la misma página.
// 2. Que lo que no es una web de internet NO llegue a la descarga. Un host sin
//    punto, un ftp:// o un esquema raro se paran antes, no porque safeFetch no
//    los pararía —los para— sino para no gastar la petición y poder dar un
//    mensaje que se entienda.
// 3. Que los topes cuenten auditorías NUEVAS y no peticiones. Negar una que
//    sale de caché no le ahorra una petición a nadie.
// 4. Que la auditoría pública vaya SIN comprobación de enlaces. Es el freno que
//    no depende de acertar con un número: limita lo que cada pulsación le hace
//    a un tercero, en vez de cuántas pulsaciones caben.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';

const auditar = vi.fn();
vi.mock('@/lib/seo-audit', () => ({
  auditWebsite: (...a: unknown[]) => auditar(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: () => {} }));

const { fotoDeWeb, normalizarUrl, MAX_AUDITORIAS_NUEVAS_POR_DIA, MAX_AUDITORIAS_NUEVAS_POR_IP } =
  await import('@/lib/auditoria-publica');

/** El título de la web falsa. Su longitud se deriva de aquí y no se cuenta a
 *  mano: contándola salió 28 y son 27. */
const TITULO = 'Fontanería Pérez — Valencia';

const AHORA = new Date('2026-09-27T16:00:00.000Z');
const HACE_MEDIA_HORA = new Date('2026-09-27T15:30:00.000Z');
const HACE_UN_DIA = new Date('2026-09-26T16:00:00.000Z');

function pagina(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      title: TITULO,
      metaDescription: null,
      h1Count: 2,
      h1Texts: [],
      imagesTotal: 12,
      imagesMissingAlt: 9,
      linksInternal: 30,
      linksExternal: 4,
      brokenLinksChecked: 0,
      brokenLinks: [],
      checkedAt: AHORA.toISOString(),
      ...over,
    },
  };
}

function prismaFalso(fila: Record<string, unknown> | null, conteos = { hoy: 0, ip: 0 }) {
  const upsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
    ...create,
    miradoEl: create.miradoEl ?? AHORA,
  }));
  const findUnique = vi.fn(async () => fila);
  return {
    upsert,
    findUnique,
    prisma: {
      auditoriaPublicaCache: {
        findUnique,
        count: async ({ where }: { where: Record<string, unknown> }) =>
          'ipHash' in where ? conteos.ip : conteos.hoy,
        upsert,
      },
    } as never,
  };
}

const GUARDADA = {
  tieneTitulo: true,
  largoTitulo: TITULO.length,
  tieneDescripcion: false,
  largoDescripcion: 0,
  h1: 2,
  imagenes: 12,
  imagenesSinAlt: 9,
  miradoEl: HACE_MEDIA_HORA,
};

beforeEach(() => { auditar.mockReset(); });

describe('normalizar la URL', () => {
  it('cuatro formas de escribir la misma web son una sola entrada de caché', () => {
    const esperada = 'https://ejemplo.com';
    expect(normalizarUrl('ejemplo.com')).toBe(esperada);
    expect(normalizarUrl('  https://ejemplo.com  ')).toBe(esperada);
    expect(normalizarUrl('https://ejemplo.com/')).toBe(esperada);
    expect(normalizarUrl('https://EJEMPLO.com/?utm_source=anuncio&gclid=x')).toBe(esperada);
  });

  it('la ruta se conserva: dos páginas de un sitio no son la misma', () => {
    expect(normalizarUrl('ejemplo.com/servicios')).toBe('https://ejemplo.com/servicios');
    expect(normalizarUrl('ejemplo.com/servicios')).not.toBe(normalizarUrl('ejemplo.com'));
  });

  it('lo que no es una web de internet no pasa', () => {
    // `ftp://archivos.example` con https delante daría un host `ftp`: ese fallo
    // ya está documentado en la ruta de sugerencias de Prospección.
    expect(normalizarUrl('ftp://archivos.example')).toBeNull();
    expect(normalizarUrl('javascript:alert(1)')).toBeNull();
    expect(normalizarUrl('localhost')).toBeNull();
    expect(normalizarUrl('localhost:3000')).toBeNull();
    expect(normalizarUrl('http://n8n:5678/rest')).toBeNull();
    expect(normalizarUrl('')).toBeNull();
    expect(normalizarUrl('   ')).toBeNull();
    expect(normalizarUrl('a'.repeat(400))).toBeNull();
  });

  it('una URL imposible no llega nunca a la descarga', async () => {
    const { prisma } = prismaFalso(null);
    expect(await fotoDeWeb(prisma, { url: 'localhost', ipHash: 'a' }, AHORA))
      .toEqual({ ok: false, error: 'url_invalida' });
    expect(auditar).not.toHaveBeenCalled();
  });
});

describe('la descarga', () => {
  it('va SIN comprobar enlaces: una petición contra un tercero, no once', async () => {
    auditar.mockResolvedValue(pagina());
    const { prisma } = prismaFalso(null);

    await fotoDeWeb(prisma, { url: 'ejemplo.com', ipHash: 'a' }, AHORA);

    expect(auditar).toHaveBeenCalledWith('https://ejemplo.com', { checkLinks: false });
  });

  it('guarda seis números y ni una palabra de la web ajena', async () => {
    auditar.mockResolvedValue(pagina());
    const { prisma, upsert } = prismaFalso(null);

    const r = await fotoDeWeb(prisma, { url: 'ejemplo.com', ipHash: 'a' }, AHORA);

    expect(r.ok && r.foto).toMatchObject({
      tieneTitulo: true, largoTitulo: TITULO.length, tieneDescripcion: false, largoDescripcion: 0,
      h1: 2, imagenes: 12, imagenesSinAlt: 9,
    });

    const guardado = JSON.stringify(upsert.mock.calls[0][0].create);
    expect(guardado).not.toContain(TITULO);
  });

  it('una web que no contesta se dice, no se inventa', async () => {
    auditar.mockResolvedValue({ ok: false, error: 'timeout' });
    const { prisma } = prismaFalso(null);

    expect(await fotoDeWeb(prisma, { url: 'ejemplo.com', ipHash: 'a' }, AHORA))
      .toEqual({ ok: false, error: 'no_alcanzable' });
  });
});

describe('la caché', () => {
  it('media hora después no se vuelve a descargar', async () => {
    const { prisma } = prismaFalso(GUARDADA);

    const r = await fotoDeWeb(prisma, { url: 'ejemplo.com', ipHash: 'a' }, AHORA);

    expect(r.ok && r.foto.largoTitulo).toBe(TITULO.length);
    expect(auditar).not.toHaveBeenCalled();
  });

  it('un día después sí, porque la vigencia es de una hora', async () => {
    // Corta a propósito: quien arregla el título vuelve a mirar el mismo día, y
    // servirle la foto de antes le diría que su arreglo no funcionó.
    auditar.mockResolvedValue(pagina({ metaDescription: 'Ya la tiene' }));
    const { prisma } = prismaFalso({ ...GUARDADA, miradoEl: HACE_UN_DIA });

    const r = await fotoDeWeb(prisma, { url: 'ejemplo.com', ipHash: 'a' }, AHORA);

    expect(auditar).toHaveBeenCalledOnce();
    expect(r.ok && r.foto.tieneDescripcion).toBe(true);
  });

  it('busca por la URL normalizada, no por la que se escribió', async () => {
    const { prisma, findUnique } = prismaFalso(GUARDADA);

    await fotoDeWeb(prisma, { url: 'HTTPS://Ejemplo.com/?utm_source=x', ipHash: 'a' }, AHORA);

    expect(findUnique).toHaveBeenCalledWith({ where: { url: 'https://ejemplo.com' } });
  });
});

describe('los topes', () => {
  it('el global, sin foto previa, niega', async () => {
    const { prisma } = prismaFalso(null, { hoy: MAX_AUDITORIAS_NUEVAS_POR_DIA, ip: 0 });

    expect(await fotoDeWeb(prisma, { url: 'ejemplo.com', ipHash: 'a' }, AHORA))
      .toEqual({ ok: false, error: 'tope_global' });
    expect(auditar).not.toHaveBeenCalled();
  });

  it('el de IP, sin foto previa, niega', async () => {
    const { prisma } = prismaFalso(null, { hoy: 0, ip: MAX_AUDITORIAS_NUEVAS_POR_IP });

    expect(await fotoDeWeb(prisma, { url: 'ejemplo.com', ipHash: 'a' }, AHORA))
      .toEqual({ ok: false, error: 'tope_ip' });
    expect(auditar).not.toHaveBeenCalled();
  });

  it('con el tope alcanzado y una foto caducada, se sirve la vieja', async () => {
    const { prisma } = prismaFalso({ ...GUARDADA, miradoEl: HACE_UN_DIA },
                                   { hoy: MAX_AUDITORIAS_NUEVAS_POR_DIA, ip: 0 });

    const r = await fotoDeWeb(prisma, { url: 'ejemplo.com', ipHash: 'a' }, AHORA);

    expect(r.ok && r.foto.largoTitulo).toBe(TITULO.length);
    expect(auditar).not.toHaveBeenCalled();
  });

  it('los topes NO frenan lo que sale de caché', async () => {
    // Si frenaran, el primero del día se llevaría la respuesta y el resto
    // vería un error por algo que no descarga nada.
    const { prisma } = prismaFalso(GUARDADA,
      { hoy: MAX_AUDITORIAS_NUEVAS_POR_DIA, ip: MAX_AUDITORIAS_NUEVAS_POR_IP });

    const r = await fotoDeWeb(prisma, { url: 'ejemplo.com', ipHash: 'a' }, AHORA);

    expect(r.ok && r.foto.h1).toBe(2);
  });
});
