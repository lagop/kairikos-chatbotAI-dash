// =============================================================================
// Cartera — acceso por token a las rutas públicas (docs/fase1-cartera.md,
// «Rutas» y «Seguridad y datos»).
//
// El feed solo responde a un token car_… de una contratación ACTIVA, y nunca
// enseña borradores. Las fotos se sirven por id solo si su casa es publicable
// y la agencia está activa; de un borrador, 404. El fichero sale del volumen
// (CARTERA_FOTOS_DIR), y una clave que intente salir de él no se lee.
// =============================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import demo from '../fixtures/cartera/demo-homes.json';

const state = vi.hoisted(() => ({
  siteFindFirst: vi.fn(),
  homeFindMany: vi.fn(),
  photoFindUnique: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: {
    carteraSite: { findFirst: (...a: unknown[]) => state.siteFindFirst(...a) },
    carteraHome: { findMany: (...a: unknown[]) => state.homeFindMany(...a) },
    carteraPhoto: { findUnique: (...a: unknown[]) => state.photoFindUnique(...a) },
  },
}));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));

import { GET as feedGet } from '@/app/api/public/cartera/[token]/feed/route';
import { GET as photoGet } from '@/app/api/public/cartera/foto/[photoId]/route';
import { findSiteByFeedToken, findSiteForClient, findSiteForOwner } from '@/lib/cartera/site';
import { resolvePhotoPath } from '@/lib/cartera/photos';
import { carteraFeedSchema } from '@/lib/cartera/schema';

const TOKEN = 'car_abcdefghijklmnopqrstuv';
const SITE_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = '22222222-2222-4222-8222-222222222222';
const PHOTO_ID = '33333333-3333-4333-8333-333333333333';
const STORAGE_KEY = `${SITE_ID}/${HOME_ID}/${PHOTO_ID}.jpg`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const getFeed = (token = TOKEN, headers: Record<string, string> = {}) =>
  feedGet(new NextRequest(`http://localhost/api/public/cartera/${token}/feed`, { headers }), { params: Promise.resolve({ token }) });
const getPhoto = (id = PHOTO_ID, headers: Record<string, string> = {}) =>
  photoGet(new NextRequest(`http://localhost/api/public/cartera/foto/${id}`, { headers }), { params: Promise.resolve({ photoId: id }) });

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cartera-fotos-'));
  mkdirSync(path.join(dir, SITE_ID, HOME_ID), { recursive: true });
  writeFileSync(path.join(dir, STORAGE_KEY), JPEG);
  process.env.CARTERA_FOTOS_DIR = dir;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CARTERA_FOTOS_DIR;
});

beforeEach(() => {
  Object.values(state).forEach((f) => f.mockReset());
});

describe('las tres búsquedas del sitio', () => {
  it('por token del feed: un token mal formado no llega a la base de datos', async () => {
    const db = { carteraSite: { findFirst: vi.fn() } };
    for (const bad of ['', 'vil_abcdefghijklmnopqrstuv', 'car_corto', `car_${'x'.repeat(61)}`, 'car_abc def ghi jkl']) {
      expect(await findSiteByFeedToken(db as never, bad)).toBeNull();
    }
    expect(db.carteraSite.findFirst).not.toHaveBeenCalled();
  });

  it('por token del feed: exige la contratación activa del producto cartera', async () => {
    const db = { carteraSite: { findFirst: vi.fn(async () => ({ id: SITE_ID })) } };
    await findSiteByFeedToken(db as never, TOKEN);
    expect(db.carteraSite.findFirst).toHaveBeenCalledWith({
      where: { feedToken: TOKEN, clientProduct: { status: 'active', product: { code: 'cartera' } } },
    });
  });

  it('para escribir: activa o en pausa', async () => {
    const db = { carteraSite: { findFirst: vi.fn(async () => null) } };
    await findSiteForClient(db as never, 'c_1');
    expect(db.carteraSite.findFirst).toHaveBeenCalledWith({
      where: { clientId: 'c_1', clientProduct: { status: { in: ['active', 'paused'] }, product: { code: 'cartera' } } },
    });
  });

  it('para leer y exportar: también en la gracia de la baja, no después', async () => {
    const now = new Date('2026-12-01T00:00:00Z');
    const site = (cancelledAt: Date, exitNotifiedAt: Date | null) => ({
      id: SITE_ID,
      exitNotifiedAt,
      clientProduct: { status: 'cancelled', cancelledAt, changedAt: cancelledAt },
    });
    const inGrace = { carteraSite: { findFirst: vi.fn(async () => site(new Date('2026-11-20T00:00:00Z'), new Date('2026-11-20T01:00:00Z'))) } };
    expect(await findSiteForOwner(inGrace as never, 'c_1', now)).toMatchObject({ state: 'grace' });

    const closed = { carteraSite: { findFirst: vi.fn(async () => site(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T01:00:00Z'))) } };
    expect(await findSiteForOwner(closed as never, 'c_1', now)).toBeNull();
  });
});

describe('GET /api/public/cartera/[token]/feed', () => {
  it('token desconocido o contratación no activa: 404', async () => {
    state.siteFindFirst.mockResolvedValue(null);
    const res = await getFeed();
    expect(res.status).toBe(404);
    expect(state.homeFindMany).not.toHaveBeenCalled();
  });

  it('pide a la base de datos sin borradores y devuelve un feed válido con ETag', async () => {
    state.siteFindFirst.mockResolvedValue({ id: SITE_ID });
    const v = demo.ventas[0] as Record<string, unknown>;
    const a = demo.alquileres[0] as Record<string, unknown>;
    state.homeFindMany.mockResolvedValue([
      { ref: v.ref, operation: 'venta', status: 'venta', data: v, errors: null, photos: [{ id: PHOTO_ID, width: 2400, height: 1600, position: 0, alt: null }] },
      { ref: a.ref, operation: 'alquiler', status: 'disponible', data: a, errors: [{ message: 'falta algo' }], photos: [] },
    ]);

    const res = await getFeed();
    expect(res.status).toBe(200);
    expect(state.homeFindMany.mock.calls[0][0]).toMatchObject({ where: { siteId: SITE_ID, status: { not: 'borrador' } } });
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();

    const body = await res.json();
    expect(carteraFeedSchema.safeParse(body).success).toBe(true);
    expect(body.ventas.map((h: { ref: string }) => h.ref)).toEqual([v.ref]);
    // La de errores se queda fuera.
    expect(body.alquileres).toEqual([]);
  });

  it('con If-None-Match igual: 304 sin cuerpo', async () => {
    state.siteFindFirst.mockResolvedValue({ id: SITE_ID });
    state.homeFindMany.mockResolvedValue([]);
    const first = await getFeed();
    const etag = first.headers.get('etag')!;
    const second = await getFeed(TOKEN, { 'if-none-match': etag });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });
});

describe('GET /api/public/cartera/foto/[photoId]', () => {
  const photo = (home: { status: string; errors: unknown }, contractStatus = 'active') => ({
    id: PHOTO_ID,
    storageKey: STORAGE_KEY,
    mime: 'image/jpeg',
    sha256: 'a'.repeat(64),
    home: { ...home, site: { clientProduct: { status: contractStatus, product: { code: 'cartera' } } } },
  });

  it('de una casa publicada: el fichero, con caché larga', async () => {
    state.photoFindUnique.mockResolvedValue(photo({ status: 'venta', errors: null }));
    const res = await getPhoto();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('etag')).toBe(`"${'a'.repeat(64)}"`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG);
  });

  it('de un borrador: 404', async () => {
    state.photoFindUnique.mockResolvedValue(photo({ status: 'borrador', errors: null }));
    expect((await getPhoto()).status).toBe(404);
  });

  it('de una casa con errores: 404', async () => {
    state.photoFindUnique.mockResolvedValue(photo({ status: 'venta', errors: [{ message: 'sin certificado' }] }));
    expect((await getPhoto()).status).toBe(404);
  });

  it('de una agencia que ya no está activa: 404', async () => {
    state.photoFindUnique.mockResolvedValue(photo({ status: 'venta', errors: null }, 'cancelled'));
    expect((await getPhoto()).status).toBe(404);
  });

  it('un id que no es un uuid no llega a la base de datos', async () => {
    expect((await getPhoto('../../etc/passwd')).status).toBe(404);
    expect(state.photoFindUnique).not.toHaveBeenCalled();
  });

  it('una fila sin fichero en el volumen: 404, no un 500', async () => {
    state.photoFindUnique.mockResolvedValue({ ...photo({ status: 'venta', errors: null }), storageKey: `${SITE_ID}/${HOME_ID}/44444444-4444-4444-8444-444444444444.jpg` });
    expect((await getPhoto()).status).toBe(404);
  });

  it('una clave que no es la que pone el portal no se resuelve a ninguna ruta', () => {
    expect(resolvePhotoPath(dir, STORAGE_KEY)).toBe(path.join(path.resolve(dir), SITE_ID, HOME_ID, `${PHOTO_ID}.jpg`));
    expect(resolvePhotoPath(dir, '../secreto.jpg')).toBeNull();
    expect(resolvePhotoPath(dir, `${SITE_ID}/../${HOME_ID}/${PHOTO_ID}.jpg`)).toBeNull();
    expect(resolvePhotoPath(dir, `${SITE_ID}/${HOME_ID}/${PHOTO_ID}.svg`)).toBeNull();
  });
});
