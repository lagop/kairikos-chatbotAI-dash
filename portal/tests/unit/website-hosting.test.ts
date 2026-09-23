// =============================================================================
// Producto Web, Fase 1 — unit tests del alojamiento propio y de las versiones.
//
// Lo que se fija:
//
// 1. Que el destino decida de verdad: con alojamiento propio NO se pide
//    credencial de SFTP ni se toca la red, y con el del cliente sí.
// 2. Que la versión se numere solo cuando la publicación SALIÓ BIEN. Una
//    versión que nunca llegó a verse no sirve para volver atrás y dejaría
//    huecos que el operador tendría que explicarse.
// 3. Que volver atrás cree una versión NUEVA con el contenido viejo, en vez
//    de borrar historial: cuando hay que explicar qué pasó, la lista de lo
//    que estuvo publicado es todo lo que se tiene.
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockState = vi.hoisted(() => ({
  findWebsite: vi.fn(),
  updateWebsite: vi.fn(),
  findRelease: vi.fn(),
  createRelease: vi.fn(),
  findFirstRelease: vi.fn(),
  upsertFile: vi.fn(),
  createAudit: vi.fn(),
  integrations: vi.fn(),
  logError: vi.fn(),
  sftp: vi.fn(),
}));

vi.mock('@/lib/website-integrations', () => ({
  resolveWebsiteIntegrations: (...a: unknown[]) => mockState.integrations(...a),
}));
vi.mock('@/lib/observability', () => ({ logError: (...a: unknown[]) => mockState.logError(...a) }));
vi.mock('ssh2-sftp-client', () => ({
  default: class {
    connect = mockState.sftp;
    put = vi.fn();
    exists = vi.fn().mockResolvedValue(true);
    mkdir = vi.fn();
    end = vi.fn().mockResolvedValue(undefined);
  },
}));

import { publishWebsite, rollbackWebsite, hostedWebsiteUrl, slugify } from '@/lib/website-publish';
import type { PrismaClient } from '@prisma/client';

const COPY = { headline: 'Titular', subheadline: '', about: '', services: [], callToAction: '' };

function site(over: Record<string, unknown> = {}) {
  return {
    id: 'w1',
    clientId: 'c1',
    tenantId: null,
    businessName: 'Fontanería Ejemplo',
    phone: '+34600112233',
    address: 'Calle Mayor 1',
    city: 'Elche',
    primaryType: 'plumber',
    themeKey: 'trades-1',
    copy: COPY,
    formToken: 'f'.repeat(48),
    publishTarget: 'kairikos',
    slug: 'fontaneria-ejemplo-ab12',
    customDomain: null,
    credential: null,
    ...over,
  };
}

const prisma = {
  clientWebsite: {
    findUnique: (...a: unknown[]) => mockState.findWebsite(...a),
    update: (...a: unknown[]) => mockState.updateWebsite(...a),
  },
  clientWebsiteRelease: {
    findFirst: (...a: unknown[]) => mockState.findFirstRelease(...a),
    create: (...a: unknown[]) => mockState.createRelease(...a),
  },
  clientWebsiteFile: { upsert: (...a: unknown[]) => mockState.upsertFile(...a) },
  clientWebsiteAudit: { create: (...a: unknown[]) => mockState.createAudit(...a) },
  $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      clientWebsite: { update: (...a: unknown[]) => mockState.updateWebsite(...a) },
      clientWebsiteRelease: { create: (...a: unknown[]) => mockState.createRelease(...a) },
      clientWebsiteAudit: { create: (...a: unknown[]) => mockState.createAudit(...a) },
    }),
} as unknown as PrismaClient;

beforeEach(() => {
  mockState.findWebsite.mockReset().mockResolvedValue(site());
  mockState.updateWebsite.mockReset().mockResolvedValue({});
  mockState.findFirstRelease.mockReset().mockResolvedValue(null);
  mockState.createRelease.mockReset().mockResolvedValue({});
  mockState.findRelease.mockReset();
  mockState.upsertFile.mockReset().mockResolvedValue({});
  mockState.createAudit.mockReset().mockResolvedValue({});
  mockState.integrations.mockReset().mockResolvedValue({ reviews: null, recallPhone: null });
  mockState.logError.mockReset();
  mockState.sftp.mockReset().mockResolvedValue(undefined);
});

describe('hostedWebsiteUrl', () => {
  it('con dominio propio manda el dominio', () => {
    expect(hostedWebsiteUrl({ slug: 'x', customDomain: 'fontaneria.es' }, 'https://portal.test')).toBe(
      'https://fontaneria.es',
    );
  });

  it('sin dominio, la dirección provisional con su slug', () => {
    expect(hostedWebsiteUrl({ slug: 'fontaneria-ab12', customDomain: null }, 'https://portal.test/')).toBe(
      'https://portal.test/sitios/fontaneria-ab12',
    );
  });

  it('sin slug no hay dirección que dar', () => {
    expect(hostedWebsiteUrl({ slug: null, customDomain: null }, 'https://portal.test')).toBeNull();
  });
});

describe('slugify', () => {
  it('quita acentos y deja algo legible', () => {
    expect(slugify('Peluquería María & Co')).toBe('peluqueria-maria-co');
  });

  it('no deja guiones sueltos en los extremos', () => {
    expect(slugify('  ¡Hola!  ')).toBe('hola');
  });
});

describe('publishWebsite con alojamiento propio', () => {
  it('guarda los archivos y no toca la red', async () => {
    const result = await publishWebsite(prisma, 'w1', { type: 'operator' });
    expect(result.ok).toBe(true);
    expect(mockState.upsertFile).toHaveBeenCalled();
    expect(mockState.sftp).not.toHaveBeenCalled();
  });

  it('no exige credencial de SFTP, que aquí no pinta nada', async () => {
    const result = await publishWebsite(prisma, 'w1', { type: 'operator' });
    expect(result.ok).toBe(true);
  });

  it('devuelve la dirección donde se puede ver ya', async () => {
    const result = await publishWebsite(prisma, 'w1', { type: 'operator' });
    if (result.ok) expect(result.url).toContain('/sitios/fontaneria-ejemplo-ab12');
  });

  it('la primera publicación es la versión 1', async () => {
    const result = await publishWebsite(prisma, 'w1', { type: 'operator' });
    if (result.ok) expect(result.version).toBe(1);
    expect(mockState.createRelease.mock.calls[0][0].data.version).toBe(1);
  });

  it('la siguiente publicación sigue la numeración', async () => {
    mockState.findFirstRelease.mockResolvedValue({ version: 7 });
    const result = await publishWebsite(prisma, 'w1', { type: 'operator' });
    if (result.ok) expect(result.version).toBe(8);
  });

  it('si la publicación falla no se numera ninguna versión', async () => {
    mockState.upsertFile.mockRejectedValue(new Error('disco lleno'));
    const result = await publishWebsite(prisma, 'w1', { type: 'operator' });
    expect(result.ok).toBe(false);
    expect(mockState.createRelease).not.toHaveBeenCalled();
    // Y el error queda en la fila, para que el operador lo vea sin logs.
    expect(mockState.updateWebsite.mock.calls[0][0].data.lastPublishError).toContain('disco lleno');
  });
});

describe('publishWebsite con alojamiento del cliente', () => {
  it('sin credencial no publica, y lo dice de forma que tenga remedio', async () => {
    mockState.findWebsite.mockResolvedValue(site({ publishTarget: 'sftp', credential: null }));
    const result = await publishWebsite(prisma, 'w1', { type: 'operator' });
    expect(result).toEqual({ ok: false, error: 'credential_missing' });
  });
});

describe('rollbackWebsite', () => {
  const prismaConRelease = {
    ...prisma,
    clientWebsiteRelease: {
      findFirst: (args: { where: { version?: number } }) =>
        args.where.version === 2
          ? Promise.resolve({ version: 2, copy: { ...COPY, headline: 'El titular de antes' }, themeKey: 'trades-3' })
          : mockState.findFirstRelease(args),
      create: (...a: unknown[]) => mockState.createRelease(...a),
    },
  } as unknown as PrismaClient;

  it('una versión que no existe no rompe nada', async () => {
    const result = await rollbackWebsite(prisma, 'w1', 99, { type: 'operator' });
    expect(result).toEqual({ ok: false, error: 'release_not_found' });
    expect(mockState.updateWebsite).not.toHaveBeenCalled();
  });

  it('restaura el contenido de esa versión antes de volver a publicar', async () => {
    await rollbackWebsite(prismaConRelease, 'w1', 2, { type: 'operator' });
    expect(mockState.updateWebsite.mock.calls[0][0].data).toMatchObject({ themeKey: 'trades-3' });
  });

  it('crea una versión NUEVA en vez de borrar historial', async () => {
    mockState.findFirstRelease.mockResolvedValue({ version: 5 });
    await rollbackWebsite(prismaConRelease, 'w1', 2, { type: 'operator' });
    expect(mockState.createRelease.mock.calls[0][0].data.version).toBe(6);
  });
});
