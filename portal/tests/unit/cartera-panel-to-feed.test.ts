// =============================================================================
// Cartera — del panel al feed (PR 2, comprobación de cierre): una casa dada de
// alta y guardada con las funciones del panel (createHome, saveHome, fotos)
// sale en el feed del PR 1 (buildFeed) y valida con el esquema copiado de la
// web. Con una base de datos falsa en memoria: el SQL de verdad se comprobó
// aparte contra Postgres (ver la descripción del PR).
//
// También: la auditoría no lleva datos personales, pendingSince se marca
// solo cuando el cambio llega a la web, el borrado deja el volumen limpio y
// dos altas a la vez no se quedan con la misma referencia.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHome, deleteHome, deleteHomeFiles, listHomesForPanel, loadHomeForPanel, saveHome } from '@/lib/cartera/homes';
import { deleteHomePhoto, reorderHomePhotos, setHomePhotoAlt, uploadHomePhoto } from '@/lib/cartera/photo-actions';
import { buildFeed } from '@/lib/cartera/feed';
import { alquilerFeedSchema, feedSchema, ventaFeedSchema } from '@/lib/cartera/schema';
import { fullAlquiler, fullVenta } from '../fixtures/cartera/full-homes';
import { fakeCarteraDb } from '../fixtures/cartera/fake-db';

const SITE = {
  id: randomUUID(),
  clientId: 'client-1',
  salePrefix: 'C',
  rentPrefix: 'A',
  agents: [
    { key: 'lucia', name: 'Lucía' },
    { key: 'elena', name: 'Elena' },
  ] as Prisma.JsonValue,
};

/** La base falsa compartida (tests/fixtures/cartera/fake-db.ts), con el sitio de SITE. */
function fakeDb(opts: { failCreateOnce?: boolean } = {}) {
  const f = fakeCarteraDb({ failNextHomeCreate: opts.failCreateOnce });
  const site = f.addSite({ id: SITE.id, clientId: SITE.clientId });
  return { db: f.db, homes: f.homes, photos: f.photos, audits: f.audits, site };
}

/** Un PNG mínimo: firma y cabecera IHDR con sus medidas. Basta para inspectImage. */
function png(width: number, height: number, extra = 0): Buffer {
  const head = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

function uploadRequest(buf: Buffer): Request {
  const form = new FormData();
  form.append('archivo', new Blob([new Uint8Array(buf)], { type: 'image/png' }), 'foto.png');
  return new Request('http://localhost/api/portal/cartera/casas/x/fotos', { method: 'POST', body: form });
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cartera-panel-'));
  process.env.CARTERA_FOTOS_DIR = dir;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.CARTERA_FOTOS_DIR;
});

const ACTOR = 'client:client-1';
const asClient = (db: unknown) => db as never;

describe('una casa del panel sale en el feed y valida con el esquema de la web', () => {
  it('alta, ficha, fotos y estado: venta y alquiler', async () => {
    const { db, homes, audits, site } = fakeDb();

    const venta = await createHome(asClient(db), SITE, 'venta', ACTOR);
    const alquiler = await createHome(asClient(db), SITE, 'alquiler', ACTOR);
    expect(venta).toMatchObject({ ok: true, ref: 'C-101' });
    expect(alquiler).toMatchObject({ ok: true, ref: 'A-201' });
    if (!venta.ok || !alquiler.ok) return;

    // Recién creada: borrador, con avisos, y ni en el feed ni marcando pendiente.
    expect(homes[0].status).toBe('borrador');
    expect((homes[0].errors as unknown[]).length).toBeGreaterThan(0);
    expect(buildFeed(homes.map((h) => ({ ...h, photos: [] })) as never, { baseUrl: 'https://portal.example' }).feed.ventas).toEqual([]);

    // Guardar como borrador ya completo: sigue fuera y sin pendiente.
    const asDraft = await saveHome(asClient(db), SITE, venta.id, { data: fullVenta() }, ACTOR);
    expect(asDraft).toMatchObject({ ok: true, status: 'borrador', errors: [] });
    expect(site.pendingSince).toBeNull();

    // Dos fotos, la segunda primero, con su texto alternativo.
    const home = homes.find((h) => h.id === venta.id)! as never as { id: string; siteId: string; ref: string; status: string; errors: Prisma.JsonValue };
    const up1 = await uploadHomePhoto(asClient(db), SITE, home, uploadRequest(png(1600, 1200)), ACTOR);
    const up2 = await uploadHomePhoto(asClient(db), SITE, home, uploadRequest(png(1200, 1600)), ACTOR);
    expect(up1.status).toBe(200);
    expect(up2.status).toBe(200);
    const id1 = (up1.body.photo as { id: string }).id;
    const id2 = (up2.body.photo as { id: string }).id;
    expect((await reorderHomePhotos(asClient(db), SITE, home, [id2, id1], ACTOR)).status).toBe(200);
    expect((await reorderHomePhotos(asClient(db), SITE, home, [id2], ACTOR)).status).toBe(400);
    expect((await setHomePhotoAlt(asClient(db), SITE, home, id2, { es: ' Fachada ', en: 'Front', de: '' }, ACTOR)).body).toEqual({ ok: true, alt: { es: 'Fachada', en: 'Front' } });

    // Publicar: estado «En venta».
    const published = await saveHome(asClient(db), SITE, venta.id, { status: 'venta', data: fullVenta() }, ACTOR);
    expect(published).toMatchObject({ ok: true, status: 'venta', errors: [], slugLocked: true });
    expect(site.pendingSince).toBeInstanceOf(Date);
    const savedAlquiler = await saveHome(asClient(db), SITE, alquiler.id, { status: 'disponible', data: fullAlquiler() }, ACTOR);
    expect(savedAlquiler).toMatchObject({ ok: true, errors: [] });

    // Bajada de precio: se apunta sola.
    const cheaper = await saveHome(asClient(db), SITE, venta.id, { data: { ...fullVenta(), price: 800000, showHistory: true } }, ACTOR);
    expect(cheaper.ok && (cheaper.data.priceHistory as unknown[]).length).toBe(2);

    // El feed, con las filas como las lee loadFeedRows.
    const rows = await db.carteraHome.findMany({ where: { siteId: SITE.id, status: { not: 'borrador' } } });
    const built = buildFeed(rows as never, { baseUrl: 'https://portal.example', now: new Date('2026-11-19T12:00:00Z') });
    expect(built.skipped).toEqual([]);
    expect(feedSchema.parse(built.feed)).toBeTruthy();
    expect(built.feed.ventas).toHaveLength(1);
    expect(built.feed.alquileres).toHaveLength(1);
    const v = ventaFeedSchema.parse(built.feed.ventas[0]);
    expect(v.ref).toBe('C-101');
    expect(v.price).toBe(800000);
    expect(v.showHistory).toBe(true);
    expect(v.photos.map((p) => p.url)).toEqual([`https://portal.example/api/public/cartera/foto/${id2}`, `https://portal.example/api/public/cartera/foto/${id1}`]);
    expect(v.photos[0]).toMatchObject({ width: 1200, height: 1600, alt: { es: 'Fachada', en: 'Front' } });
    expect(alquilerFeedSchema.parse(built.feed.alquileres[0]).ref).toBe('A-201');

    // Lo que lee el panel.
    const list = await listHomesForPanel(asClient(db), SITE.id);
    expect(list.find((h) => h.id === venta.id)).toMatchObject({ ref: 'C-101', status: 'venta', price: 800000, title: 'Villa con vistas al mar', published: true, photoCount: 2, errors: [] });
    const sheet = await loadHomeForPanel(asClient(db), SITE.id, venta.id);
    expect(sheet?.photos.map((p) => p.id)).toEqual([id2, id1]);

    // Auditoría: alta, fotos, precio, estado. Sin datos personales: ni textos
    // ni la imagen; solo referencias, campos, medidas y precios.
    const actions = audits.map((a) => a.action);
    for (const expected of ['created', 'photo_added', 'photos_reordered', 'photo_alt_updated', 'status_changed', 'first_published', 'price_changed', 'updated']) {
      expect(actions).toContain(expected);
    }
    const dump = JSON.stringify(audits.map((a) => a.metadata));
    expect(dump).not.toMatch(/Villa con vistas|Fachada|Cuatro dormitorios/);
    expect(audits.every((a) => a.actor === ACTOR && a.clientId === 'client-1')).toBe(true);
  });
});

describe('borrar', () => {
  it('un borrador con fotos se borra entero, ficheros incluidos; una casa publicada, no', async () => {
    const { db, homes, audits } = fakeDb();
    const created = await createHome(asClient(db), SITE, 'venta', ACTOR);
    if (!created.ok) throw new Error('no se creó');
    const home = homes[0] as never as { id: string; siteId: string; ref: string; status: string; errors: Prisma.JsonValue };
    await uploadHomePhoto(asClient(db), SITE, home, uploadRequest(png(800, 600)), ACTOR);
    const homeDir = path.join(dir, SITE.id, created.id);
    expect(readdirSync(homeDir)).toHaveLength(1);

    const r = await deleteHome(asClient(db), SITE, created.id, ACTOR);
    expect(r.ok).toBe(true);
    if (r.ok) await deleteHomeFiles(r.storageKeys);
    expect(readdirSync(homeDir)).toHaveLength(0);
    expect(homes).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({ action: 'deleted', metadata: { ref: 'C-101', photos: 1 } });

    const again = await createHome(asClient(db), SITE, 'venta', ACTOR);
    if (!again.ok) throw new Error('no se creó');
    await saveHome(asClient(db), SITE, again.id, { status: 'venta', data: fullVenta() }, ACTOR);
    expect(await deleteHome(asClient(db), SITE, again.id, ACTOR)).toEqual({ ok: false, error: 'not_a_draft' });
    expect(await saveHome(asClient(db), SITE, again.id, { status: 'borrador', data: fullVenta() }, ACTOR)).toEqual({ ok: false, error: 'published_to_draft' });
  });

  it('quitar una foto corre las demás y borra su fichero', async () => {
    const { db, homes, photos } = fakeDb();
    const created = await createHome(asClient(db), SITE, 'venta', ACTOR);
    if (!created.ok) throw new Error('no se creó');
    const home = homes[0] as never as { id: string; siteId: string; ref: string; status: string; errors: Prisma.JsonValue };
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(((await uploadHomePhoto(asClient(db), SITE, home, uploadRequest(png(800, 600)), ACTOR)).body.photo as { id: string }).id);
    expect((await deleteHomePhoto(asClient(db), SITE, home, ids[0], ACTOR)).status).toBe(200);
    expect(photos.map((p) => [p.id, p.position])).toEqual([
      [ids[1], 0],
      [ids[2], 1],
    ]);
    expect(readdirSync(path.join(dir, SITE.id, created.id))).toHaveLength(2);
    expect((await deleteHomePhoto(asClient(db), SITE, home, ids[0], ACTOR)).status).toBe(404);
  });
});

describe('referencias', () => {
  it('si otra alta se queda la referencia a la vez, se reintenta con la siguiente', async () => {
    const { db } = fakeDb({ failCreateOnce: true });
    const r = await createHome(asClient(db), SITE, 'venta', ACTOR);
    expect(r).toMatchObject({ ok: true, ref: 'C-102' });
  });

  it('una casa de otro sitio no se encuentra', async () => {
    const { db } = fakeDb();
    const created = await createHome(asClient(db), SITE, 'venta', ACTOR);
    if (!created.ok) throw new Error('no se creó');
    const other = { ...SITE, id: randomUUID() };
    expect(await saveHome(asClient(db), other, created.id, { data: fullVenta() }, ACTOR)).toEqual({ ok: false, error: 'not_found' });
    expect(await deleteHome(asClient(db), other, created.id, ACTOR)).toEqual({ ok: false, error: 'not_found' });
    expect(await loadHomeForPanel(asClient(db), other.id, created.id)).toBeNull();
  });
});
