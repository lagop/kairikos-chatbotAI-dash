// =============================================================================
// Cartera — la exportación y la baja (PR 6). El ZIP del contrato
// (docs/exportacion.md de la plantilla web), su validación previa, el acceso
// en la gracia de la baja, el aviso a la agencia y la purga del cron con los
// archivos del volumen. Base de datos falsa en memoria
// (tests/fixtures/cartera/fake-db.ts), fotos en una carpeta temporal y Resend
// simulado.
//
// El ZIP se lee con un lector mínimo de aquí abajo, que comprueba además el
// CRC de cada entrada. La prueba de que una web de verdad construye con él se
// hizo aparte (descripción del PR): descomprimirlo sobre una copia del
// repositorio de la web y `npm run build` sin el feed.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { NextRequest } from 'next/server';
import { fakeCarteraDb, type FakeCarteraDb } from '../fixtures/cartera/fake-db';
import { fullAlquiler, fullVenta } from '../fixtures/cartera/full-homes';

const state = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  admin: true,
  sent: [] as Array<{ from: string; to: string[]; subject: string; text: string }>,
}));

vi.mock('@/lib/prisma', () => ({
  isDatabaseConfigured: true,
  prisma: new Proxy({}, { get: (_t, key) => state.db[key as string] }),
}));
vi.mock('@/lib/session', () => ({ getSession: async () => ({ hasClientAccess: true }) }));
vi.mock('@/lib/portal-session', () => ({ resolveClientFromSession: async () => ({ source: 'database', clientId: 'client-1' }) }));
vi.mock('@/lib/operator-session', () => ({
  authenticateAdminRequest: async () => (state.admin ? { ok: true, sessionId: 's-1', operatorId: 'op-1' } : { ok: false }),
}));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/leads', () => ({ hasLeadsInboxAccess: async () => false }));
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (m: { from: string; to: string[]; subject: string; text: string }) => {
        state.sent.push(m);
        return { data: { id: `msg-${state.sent.length}` }, error: null };
      },
    };
  },
}));

import { GET as exportGet } from '@/app/api/portal/cartera/exportar/route';
import { GET as adminExportGet } from '@/app/api/admin/portal/cartera/[siteId]/exportar/route';
import { GET as feedGet } from '@/app/api/public/cartera/[token]/feed/route';
import { GET as photoGet } from '@/app/api/public/cartera/foto/[photoId]/route';
import { POST as contactPost } from '@/app/api/public/cartera/[token]/contacto/route';
import { PATCH as enquiriesPatch } from '@/app/api/portal/cartera/contactos/route';
import { createHome, saveHome } from '@/lib/cartera/homes';
import { buildContactsCsv, csvCell, exportFileName, planCarteraExport } from '@/lib/cartera/export';
import { processCarteraExits, removeSitePhotos } from '@/lib/cartera/exit';
import { sweepCartera } from '@/lib/cartera/publish';
import { zipStream } from '@/lib/cartera/zip';
import { alquilerFeedSchema, ventaFeedSchema, LOCAL_PHOTO } from '@/lib/cartera/schema';

const ACTOR = 'client:client-1';
const DAY = 86_400_000;

let f: FakeCarteraDb;
let dir: string;

beforeEach(async () => {
  f = fakeCarteraDb();
  state.db = f.db as never;
  state.sent.length = 0;
  state.admin = true;
  dir = await mkdtemp(path.join(tmpdir(), 'cartera-fotos-'));
  process.env.CARTERA_FOTOS_DIR = dir;
  process.env.RESEND_API_KEY = 're_prueba';
});
afterEach(async () => {
  delete process.env.CARTERA_FOTOS_DIR;
  delete process.env.RESEND_API_KEY;
  await rm(dir, { recursive: true, force: true });
});

const asPrisma = () => f.db as never;

// --- Un lector de ZIP mínimo -----------------------------------------------------------------

interface ZipFile {
  name: string;
  data: Buffer;
  method: number;
  flags: number;
}

/** Recorre el directorio central y saca cada entrada de su cabecera local,
 *  comprobando el CRC: si el escritor se equivoca en un desplazamiento o en
 *  un tamaño, aquí revienta. */
function readZip(buf: Buffer): ZipFile[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(-1);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipFile[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    expect(crc32(data) >>> 0, name).toBe(crc);
    out.push({ name, data, method, flags });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of gen) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

// --- Datos de prueba ---------------------------------------------------------------------------

/** Una foto en la base de datos y su archivo en el volumen. */
async function addPhoto(siteId: string, homeId: string, position: number, mime: string, bytes: Buffer = Buffer.from(`foto-${position}-${randomUUID()}`)) {
  const id = randomUUID();
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const storageKey = `${siteId}/${homeId}/${id}.${ext}`;
  await mkdir(path.join(dir, siteId, homeId), { recursive: true });
  await writeFile(path.join(dir, storageKey), bytes);
  f.photos.push({ id, homeId, position, width: 1600, height: 1067, alt: { es: `Foto ${position}`, en: '' }, storageKey, mime, bytes: bytes.length, sha256: 'x' });
  return { id, storageKey, bytes };
}

/** Una foto 360° (equirrectangular, 2:1) en la base de datos y en el volumen. */
async function addPano(siteId: string, homeId: string, position: number, bytes: Buffer = Buffer.from(`pano-${position}-${randomUUID()}`)) {
  const id = randomUUID();
  const storageKey = `${siteId}/${homeId}/${id}.jpg`;
  await mkdir(path.join(dir, siteId, homeId), { recursive: true });
  await writeFile(path.join(dir, storageKey), bytes);
  f.panos.push({ id, homeId, position, width: 4096, height: 2048, storageKey, mime: 'image/jpeg', bytes: bytes.length, sha256: 'x' });
  return { id, storageKey, bytes };
}

/**
 * Una agencia con: C-101 en venta (dos fotos, JPEG y PNG, y una foto 360°),
 * A-201 en alquiler (una WebP), C-102 borrador (una foto y una foto 360°) y
 * dos contactos.
 */
async function agency(over: Parameters<FakeCarteraDb['addSite']>[0] = {}) {
  const site = f.addSite(over);
  const venta = await createHome(asPrisma(), site, 'venta', ACTOR);
  const alquiler = await createHome(asPrisma(), site, 'alquiler', ACTOR);
  const draft = await createHome(asPrisma(), site, 'venta', ACTOR);
  if (!venta.ok || !alquiler.ok || !draft.ok) throw new Error('alta');
  await saveHome(asPrisma(), site, venta.id, { status: 'venta', data: fullVenta() }, ACTOR);
  await saveHome(asPrisma(), site, alquiler.id, { status: 'disponible', data: fullAlquiler() }, ACTOR);
  await saveHome(asPrisma(), site, draft.id, { data: { title: { es: 'Ático a medias' } } }, ACTOR);
  const photos = {
    venta1: await addPhoto(site.id, venta.id, 0, 'image/jpeg'),
    venta2: await addPhoto(site.id, venta.id, 1, 'image/png'),
    alquiler1: await addPhoto(site.id, alquiler.id, 0, 'image/webp'),
    draft1: await addPhoto(site.id, draft.id, 0, 'image/jpeg'),
  };
  const panos = {
    venta1: await addPano(site.id, venta.id, 0),
    draft1: await addPano(site.id, draft.id, 0),
  };
  f.enquiries.push(
    {
      id: randomUUID(),
      siteId: site.id,
      kind: 'visit',
      refs: ['C-101'],
      name: 'Ana Pérez',
      contact: '=HYPERLINK("http://x")',
      lang: 'es',
      consentAt: new Date('2026-11-10T09:30:00Z'),
      status: 'nuevo',
      payload: { when: 'tarde' },
      createdAt: new Date('2026-11-10T09:30:00Z'),
      leadId: null,
    },
    {
      id: randomUUID(),
      siteId: site.id,
      kind: 'saved_email',
      refs: ['C-101', 'A-201'],
      name: null,
      contact: 'hans@example.de',
      lang: 'de',
      consentAt: new Date('2026-11-12T18:00:00Z'),
      status: 'atendido',
      payload: {},
      createdAt: new Date('2026-11-12T18:00:00Z'),
      leadId: null,
    },
  );
  return { site, ventaId: venta.id, alquilerId: alquiler.id, draftId: draft.id, photos, panos };
}

const adminReq = (siteId: string) => new NextRequest(`http://localhost/api/admin/portal/cartera/${siteId}/exportar`);
const portalReq = (q = '') => new NextRequest(`http://localhost/api/portal/cartera/exportar${q}`);

// =============================================================================

describe('el ZIP del contrato', () => {
  it('lleva la estructura de docs/exportacion.md, en minúsculas y en orden', async () => {
    const a = await agency();
    const res = await exportGet(portalReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="cartera-alfeizar-inmobiliaria-\d{4}-\d{2}-\d{2}\.zip"$/);

    const files = readZip(Buffer.from(await res.arrayBuffer()));
    // Cada foto (y cada foto 360°) con el id que tiene en el portal: el nombre
    // por el que la web casa sus cotas y panoRooms (ver la cabecera de export.ts).
    const { photos: ph, panos: pa } = a;
    expect(files.map((x) => x.name)).toEqual([
      'LEEME.txt',
      'src/content/inmuebles/c-101.json',
      'src/content/alquileres/a-201.json',
      `src/content/fotos/c-101/${ph.venta1.id}.jpg`,
      `src/content/fotos/c-101/${ph.venta2.id}.png`,
      `src/content/fotos/c-101/${pa.venta1.id}.jpg`,
      `src/content/fotos/a-201/${ph.alquiler1.id}.webp`,
      'borradores/c-102.json',
      `borradores/fotos/c-102/${ph.draft1.id}.jpg`,
      `borradores/fotos/c-102/${pa.draft1.id}.jpg`,
      'contactos.csv',
    ]);
    // Todo en minúsculas salvo LEEME.txt (que lo fija el contrato), sin
    // compresión, con nombres UTF-8 y sin rutas que se salgan.
    for (const file of files) {
      if (file.name !== 'LEEME.txt') expect(file.name).toBe(file.name.toLowerCase());
      expect(file.name).not.toMatch(/(^\/|\.\.)/);
      expect(file.method).toBe(0);
      expect(file.flags & 0x0800).toBe(0x0800);
    }
    // Las fotos son los bytes del volumen, tal cual.
    const byName = new Map(files.map((x) => [x.name, x.data]));
    expect(byName.get(`src/content/fotos/c-101/${ph.venta1.id}.jpg`)!.equals(ph.venta1.bytes)).toBe(true);
    expect(byName.get(`src/content/fotos/c-101/${ph.venta2.id}.png`)!.equals(ph.venta2.bytes)).toBe(true);
    expect(byName.get(`src/content/fotos/c-101/${pa.venta1.id}.jpg`)!.equals(pa.venta1.bytes)).toBe(true);
    expect(byName.get(`src/content/fotos/a-201/${ph.alquiler1.id}.webp`)!.equals(ph.alquiler1.bytes)).toBe(true);
    expect(byName.get(`borradores/fotos/c-102/${ph.draft1.id}.jpg`)!.equals(ph.draft1.bytes)).toBe(true);
    expect(byName.get(`borradores/fotos/c-102/${pa.draft1.id}.jpg`)!.equals(pa.draft1.bytes)).toBe(true);
  });

  it('cada JSON de src/content/ valida con el esquema de la web y su url apunta al archivo del ZIP', async () => {
    const { photos: ph, panos: pa } = await agency();
    const files = readZip(Buffer.from(await (await exportGet(portalReq())).arrayBuffer()));
    const names = new Set(files.map((x) => x.name));
    const venta = JSON.parse(files.find((x) => x.name === 'src/content/inmuebles/c-101.json')!.data.toString('utf8'));
    const alquiler = JSON.parse(files.find((x) => x.name === 'src/content/alquileres/a-201.json')!.data.toString('utf8'));
    expect(ventaFeedSchema.safeParse(venta).success).toBe(true);
    expect(alquilerFeedSchema.safeParse(alquiler).success).toBe(true);
    expect(venta.ref).toBe('C-101');
    expect(venta.photos.map((p: { url: string }) => p.url)).toEqual([`fotos/c-101/${ph.venta1.id}.jpg`, `fotos/c-101/${ph.venta2.id}.png`]);
    expect(venta.photos[0]).toEqual({ url: `fotos/c-101/${ph.venta1.id}.jpg`, width: 1600, height: 1067, alt: { es: 'Foto 0' } });
    expect(venta.panos).toEqual([{ url: `fotos/c-101/${pa.venta1.id}.jpg`, width: 4096, height: 2048 }]);
    expect(alquiler.photos.map((p: { url: string }) => p.url)).toEqual([`fotos/a-201/${ph.alquiler1.id}.webp`]);
    // Sin fotos 360°, sin el campo: como en el feed.
    expect('panos' in alquiler).toBe(false);
    for (const p of [...venta.photos, ...venta.panos, ...alquiler.photos]) {
      expect(p.url).toMatch(LOCAL_PHOTO);
      expect(names.has(`src/content/${p.url}`)).toBe(true);
    }
    // Ni una URL del portal: la web construye sin él.
    expect(JSON.stringify([venta, alquiler])).not.toContain('/api/public/cartera');
  });

  it('los borradores van fuera de src/, con sus errores y la url de sus fotos ya relativa', async () => {
    const { photos: ph, panos: pa } = await agency();
    const files = readZip(Buffer.from(await (await exportGet(portalReq())).arrayBuffer()));
    expect(files.filter((x) => x.name.startsWith('src/') && x.name.includes('c-102'))).toEqual([]);
    const draft = JSON.parse(files.find((x) => x.name === 'borradores/c-102.json')!.data.toString('utf8'));
    expect(draft).toMatchObject({ ref: 'C-102', status: 'borrador', title: { es: 'Ático a medias' } });
    expect(Array.isArray(draft.errors)).toBe(true);
    expect(draft.photos).toEqual([{ url: `fotos/c-102/${ph.draft1.id}.jpg`, width: 1600, height: 1067, alt: { es: 'Foto 0' } }]);
    expect(draft.panos).toEqual([{ url: `fotos/c-102/${pa.draft1.id}.jpg`, width: 4096, height: 2048 }]);
  });

  it('una casa publicable que el esquema rechaza va a borradores con un aviso, no a src/', async () => {
    const a = await agency();
    // Publicable (sin errores, no es borrador) pero sin datos que validen.
    const broken = await createHome(asPrisma(), a.site, 'alquiler', ACTOR);
    if (!broken.ok) throw new Error('alta');
    Object.assign(
      f.homes.find((h) => h.id === broken.id)!,
      { status: 'disponible', errors: [], data: { title: { es: 'Sin acabar' } } },
    );
    const plan = await planCarteraExport(asPrisma(), a.site);
    if (!plan.ok) throw new Error(plan.error);
    const names = plan.plan.entries.map((e) => e.name);
    expect(names).toContain('borradores/a-202.json');
    expect(names.some((n) => n.startsWith('src/') && n.includes('a-202'))).toBe(false);
    const entry = plan.plan.entries.find((e) => e.name === 'borradores/a-202.json')!;
    const doc = JSON.parse(Buffer.from((entry as { data: Uint8Array }).data).toString('utf8'));
    expect(doc.errors).toEqual([{ path: '', message: 'No valida con el formato de la web.' }]);
  });

  it('contactos.csv: BOM, punto y coma, CRLF, el tipo en español y sin fórmulas', async () => {
    await agency();
    const files = readZip(Buffer.from(await (await exportGet(portalReq())).arrayBuffer()));
    const csv = files.find((x) => x.name === 'contactos.csv')!.data.toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('fecha;tipo;referencias;nombre;contacto;idioma;consentimiento;estado;detalle');
    expect(lines).toHaveLength(4); // cabecera, dos contactos y la línea vacía del final
    expect(lines[1].startsWith('2026-11-10 10:30;Visita;C-101;')).toBe(true); // hora de Madrid, el tipo en español
    expect(lines[1]).toContain(';Ana Pérez;');
    // Una celda que Excel tomaría por fórmula sale como texto.
    expect(lines[1]).toContain(`;"'=HYPERLINK(""http://x"")";`);
    expect(lines[2]).toContain(';C-101 A-201;;hans@example.de;de;');
    expect(lines[2]).toContain(';atendido;');
  });

  it('csvCell y buildContactsCsv, sueltos', () => {
    expect(csvCell('hola')).toBe('hola');
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('dice "sí"')).toBe('"dice ""sí"""');
    expect(csvCell('línea\nsegunda')).toBe('"línea\nsegunda"');
    expect(csvCell('+34 600')).toBe("'+34 600");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell(null)).toBe('');
    expect(buildContactsCsv([])).toBe('﻿fecha;tipo;referencias;nombre;contacto;idioma;consentimiento;estado;detalle\r\n');
    expect(exportFileName('Alféizar Inmobiliaria, S.L.', new Date('2026-11-19T23:30:00Z'))).toBe('cartera-alfeizar-inmobiliaria-s-l-2026-11-20.zip');
  });

  it('LEEME.txt explica cómo usarlo y avisa de los datos personales', async () => {
    await agency();
    const files = readZip(Buffer.from(await (await exportGet(portalReq())).arrayBuffer()));
    const readme = files[0].data.toString('utf8');
    expect(readme).toContain('Alféizar Inmobiliaria');
    expect(readme).toContain('2 casas publicables, 1 sin publicar, 4 fotos, 2 fotos 360° y 2 contactos.');
    expect(readme).toContain('PORTFOLIO_FEED_URL');
    expect(readme).toContain('DATOS PERSONALES');
    expect(readme).toContain('\r\n');
  });

  it('una cartera vacía también da un ZIP válido', async () => {
    f.addSite();
    const files = readZip(Buffer.from(await (await exportGet(portalReq())).arrayBuffer()));
    expect(files.map((x) => x.name)).toEqual(['LEEME.txt', 'contactos.csv']);
  });
});

describe('la validación previa: si algo falla, no hay ZIP', () => {
  it('una foto que falta en el volumen da 500 export_failed, sin ZIP y sin auditoría', async () => {
    const a = await agency();
    await rm(path.join(dir, a.photos.venta2.storageKey));
    const res = await exportGet(portalReq());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'export_failed' });
    expect(f.audits.filter((x) => x.action === 'exported')).toEqual([]);
  });

  it('un JSON de src/content/ que no valida para la exportación entera', async () => {
    const a = await agency();
    // Un tipo que la subida nunca deja pasar: conserva su extensión y la web no la acepta.
    f.photos.find((p) => p.id === a.photos.venta2.id)!.mime = 'image/gif';
    const plan = await planCarteraExport(asPrisma(), a.site);
    expect(plan).toMatchObject({ ok: false, error: 'invalid_home' });
    expect(!plan.ok && plan.detail).toContain('C-101');
    const res = await exportGet(portalReq());
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('con fotos y sin CARTERA_FOTOS_DIR no hay ZIP', async () => {
    const a = await agency();
    delete process.env.CARTERA_FOTOS_DIR;
    expect(await planCarteraExport(asPrisma(), a.site)).toMatchObject({ ok: false, error: 'storage_not_configured' });
  });

  it('el operador recibe el motivo; la agencia, solo el código', async () => {
    const a = await agency();
    await rm(path.join(dir, a.photos.alquiler1.storageKey));
    const res = await adminExportGet(adminReq(a.site.id), { params: Promise.resolve({ siteId: a.site.id }) });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'export_failed', reason: 'missing_photo' });
  });

  it('?comprobar=1 prepara sin mandar ni auditar', async () => {
    await agency();
    const res = await exportGet(portalReq('?comprobar=1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, counts: { homes: 2, drafts: 1, photos: 4, panos: 2, enquiries: 2 } });
    expect(f.audits.filter((x) => x.action === 'exported')).toEqual([]);
  });
});

describe('la auditoría de cada descarga', () => {
  it('la agencia y el operador quedan como autores, con recuentos y sin datos personales', async () => {
    const a = await agency();
    await (await exportGet(portalReq())).arrayBuffer();
    await (await adminExportGet(adminReq(a.site.id), { params: Promise.resolve({ siteId: a.site.id }) })).arrayBuffer();
    const exported = f.audits.filter((x) => x.action === 'exported');
    expect(exported.map((x) => x.actor)).toEqual(['client:client-1', 'operator:op-1']);
    for (const row of exported) {
      expect(row).toMatchObject({ entity: 'export', entityId: a.site.id, siteId: a.site.id, metadata: { homes: 2, drafts: 1, photos: 4, panos: 2, enquiries: 2 } });
      const text = JSON.stringify(row);
      for (const pii of ['Ana', 'hans@', 'HYPERLINK', 'Alféizar']) expect(text).not.toContain(pii);
    }
  });

  it('el operador: sin sesión 401, id raro o sitio que no existe 404', async () => {
    const a = await agency();
    state.admin = false;
    expect((await adminExportGet(adminReq(a.site.id), { params: Promise.resolve({ siteId: a.site.id }) })).status).toBe(401);
    state.admin = true;
    expect((await adminExportGet(adminReq('../x'), { params: Promise.resolve({ siteId: '../x' }) })).status).toBe(404);
    const other = randomUUID();
    expect((await adminExportGet(adminReq(other), { params: Promise.resolve({ siteId: other }) })).status).toBe(404);
  });
});

describe('la gracia de la baja', () => {
  const cancelledAt = new Date(Date.now() - 3 * DAY);

  it('el panel es de solo lectura pero la exportación funciona', async () => {
    const a = await agency({ contractStatus: 'cancelled', cancelledAt, exitNotifiedAt: new Date(Date.now() - 2 * DAY) });
    const res = await exportGet(portalReq());
    expect(res.status).toBe(200);
    expect(readZip(Buffer.from(await res.arrayBuffer())).length).toBe(11);
    const id = f.enquiries[0].id;
    const write = await enquiriesPatch(
      new NextRequest('http://localhost/api/portal/cartera/contactos', { method: 'PATCH', body: JSON.stringify({ id, status: 'atendido' }), headers: { 'content-type': 'application/json' } }),
    );
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({ error: 'read_only' });
    expect(a.site.id).toBeTruthy();
  });

  it('el feed, las fotos públicas y el formulario de contacto dejan de responder', async () => {
    const a = await agency({ contractStatus: 'cancelled', cancelledAt });
    const token = String(a.site.feedToken);
    const feed = await feedGet(new NextRequest(`http://localhost/api/public/cartera/${token}/feed`), { params: Promise.resolve({ token }) });
    expect(feed.status).toBe(404);
    const photo = await photoGet(new NextRequest(`http://localhost/api/public/cartera/foto/${a.photos.venta1.id}`), { params: Promise.resolve({ photoId: a.photos.venta1.id }) });
    expect(photo.status).toBe(404);
    const contact = await contactPost(
      new NextRequest(`http://localhost/api/public/cartera/${token}/contacto`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://agencia.example' },
        body: JSON.stringify({ kind: 'question', ref: 'C-101', message: 'Hola', name: 'Ana', contact: 'ana@example.com', consent: true, lang: 'es', website: '' }),
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(contact.status).toBe(404);
  });

  it('con la contratación activa, las mismas tres responden (control)', async () => {
    const a = await agency();
    const token = String(a.site.feedToken);
    expect((await feedGet(new NextRequest(`http://localhost/api/public/cartera/${token}/feed`), { params: Promise.resolve({ token }) })).status).toBe(200);
    expect((await photoGet(new NextRequest('http://localhost/x'), { params: Promise.resolve({ photoId: a.photos.venta1.id }) })).status).toBe(200);
  });

  it('pasado el plazo, la agencia ya no entra ni exporta (el operador sí, hasta la purga)', async () => {
    const a = await agency({ contractStatus: 'cancelled', cancelledAt: new Date(Date.now() - 40 * DAY), exitNotifiedAt: new Date(Date.now() - 39 * DAY) });
    expect((await exportGet(portalReq())).status).toBe(403);
    expect((await adminExportGet(adminReq(a.site.id), { params: Promise.resolve({ siteId: a.site.id }) })).status).toBe(200);
  });
});

describe('la baja desde el cron', () => {
  it('avisa a la agencia una sola vez, con el plazo, y lo audita sin datos personales', async () => {
    const now = new Date('2026-11-20T10:00:00Z');
    const a = await agency({ contractStatus: 'cancelled', cancelledAt: new Date('2026-11-18T08:00:00Z') });
    const r1 = await processCarteraExits(asPrisma(), now);
    expect(r1).toEqual({ notified: 1, purged: 0 });
    expect(f.sites[0].exitNotifiedAt).toEqual(now);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].to).toEqual(['agencia@example.com']);
    expect(state.sent[0].subject).toBe('Tu cartera se borra el 18 de diciembre: descarga tus casas antes');
    expect(state.sent[0].text).toContain('Hola, Alféizar Inmobiliaria:');
    expect(state.sent[0].text).toContain('Tus 3 casas');
    expect(state.sent[0].text).toContain('los 2 contactos');
    expect(state.sent[0].text).toContain('Exportar');
    expect(state.sent[0].text).toContain('/portal/cartera');
    const notice = f.audits.find((x) => x.action === 'exit_notified')!;
    expect(notice).toMatchObject({ siteId: a.site.id, actor: 'system', metadata: { graceEndsAt: '2026-12-18T08:00:00.000Z', homes: 3, enquiries: 2 } });

    // El siguiente pase no vuelve a avisar ni purga todavía.
    expect(await processCarteraExits(asPrisma(), new Date(now.getTime() + DAY))).toEqual({ notified: 0, purged: 0 });
    expect(state.sent).toHaveLength(1);
  });

  it('un aviso tardío alarga el plazo a 7 días desde el aviso', async () => {
    const now = new Date('2026-11-20T10:00:00Z');
    await agency({ contractStatus: 'cancelled', cancelledAt: new Date('2026-10-01T00:00:00Z') });
    await processCarteraExits(asPrisma(), now);
    expect(f.audits.find((x) => x.action === 'exit_notified')!.metadata).toMatchObject({ graceEndsAt: '2026-11-27T10:00:00.000Z' });
    expect(await processCarteraExits(asPrisma(), new Date('2026-11-26T10:00:00Z'))).toEqual({ notified: 0, purged: 0 });
    expect(f.sites).toHaveLength(1);
  });

  it('pasado el plazo purga casas, fotos del volumen, contactos y publicaciones, y lo deja en clientProductAudit', async () => {
    const a = await agency({ contractStatus: 'cancelled', cancelledAt: new Date('2026-10-01T00:00:00Z'), exitNotifiedAt: new Date('2026-10-02T00:00:00Z') });
    f.builds.push({ id: randomUUID(), siteId: a.site.id, status: 'correcta', dispatchedAt: new Date('2026-10-01T00:00:00Z') });
    // Otra agencia, activa, en el mismo volumen: no se toca.
    const other = await agency({ clientId: 'client-2' });
    expect(await readdir(dir)).toHaveLength(2);

    const r = await processCarteraExits(asPrisma(), new Date('2026-11-20T10:00:00Z'));
    expect(r).toEqual({ notified: 0, purged: 1 });
    expect(await readdir(dir)).toEqual([other.site.id]);
    expect(f.sites.map((s) => s.id)).toEqual([other.site.id]);
    expect(f.homes.every((h) => h.siteId === other.site.id)).toBe(true);
    expect(f.photos.every((p) => p.storageKey && String(p.storageKey).startsWith(other.site.id))).toBe(true);
    expect(f.enquiries.every((e) => e.siteId === other.site.id)).toBe(true);
    expect(f.builds).toEqual([]);
    expect(f.productAudits).toEqual([
      {
        clientProductId: a.site.clientProductId,
        clientId: 'client-1',
        productId: 'product-cartera',
        tenantId: null,
        action: 'cartera_data_purged',
        statusBefore: 'cancelled',
        statusAfter: 'cancelled',
        actorId: 'system:cartera-exit',
      },
    ]);
  });

  it('sin CARTERA_FOTOS_DIR y con fotos no purga nada (ni filas): no deja archivos huérfanos', async () => {
    await agency({ contractStatus: 'cancelled', cancelledAt: new Date('2026-10-01T00:00:00Z'), exitNotifiedAt: new Date('2026-10-02T00:00:00Z') });
    delete process.env.CARTERA_FOTOS_DIR;
    expect(await processCarteraExits(asPrisma(), new Date('2026-11-20T10:00:00Z'))).toEqual({ notified: 0, purged: 0 });
    expect(f.sites).toHaveLength(1);
    expect(f.productAudits).toEqual([]);
  });

  it('una contratación activa o en pausa no entra en la baja', async () => {
    await agency({ contractStatus: 'paused', exitNotifiedAt: null });
    await agency({ clientId: 'client-2' });
    expect(await processCarteraExits(asPrisma(), new Date())).toEqual({ notified: 0, purged: 0 });
    expect(state.sent).toEqual([]);
  });

  it('removeSitePhotos solo borra la carpeta de un uuid dentro del volumen', async () => {
    await expect(removeSitePhotos(dir, '..')).rejects.toThrow();
    await expect(removeSitePhotos(dir, '../../etc')).rejects.toThrow();
    // Una carpeta que no existe no es un error.
    await expect(removeSitePhotos(dir, randomUUID())).resolves.toBeUndefined();
  });

  it('va en el barrido del cron (sweepCartera)', async () => {
    await agency({ contractStatus: 'cancelled', cancelledAt: new Date() });
    const r = await sweepCartera(asPrisma());
    expect(r.exits).toEqual({ notified: 1, purged: 0 });
  });
});

describe('el escritor de ZIP', () => {
  it('nombres UTF-8, datos en memoria y en disco, y ZIP64 solo si hace falta', async () => {
    const file = path.join(dir, 'x.bin');
    await writeFile(file, Buffer.alloc(300_000, 7));
    const buf = await collect(
      zipStream([
        { name: 'ñandú.txt', data: Buffer.from('hola') },
        { name: 'grande.bin', file, size: 300_000 },
      ]),
    );
    const files = readZip(buf);
    expect(files.map((x) => x.name)).toEqual(['ñandú.txt', 'grande.bin']);
    expect(files[1].data.length).toBe(300_000);
    expect(buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(false);
  });

  it('si un archivo cambia de tamaño entre el plan y la copia, corta', async () => {
    const file = path.join(dir, 'y.bin');
    await writeFile(file, Buffer.alloc(10));
    await expect(collect(zipStream([{ name: 'y.bin', file, size: 11 }]))).rejects.toThrow(/cambiado de tamaño/);
  });
});

// La prueba de cierre del brief, a mano: con CARTERA_ZIP_OUT=<ruta.zip> escribe
// el ZIP de una agencia con fotos de verdad (sharp), para descomprimirlo sobre
// una COPIA del repositorio de la web y construir sin el feed. Sin la variable
// no corre: necesita el repositorio de la web y su build, que no es de la suite.
describe.skipIf(!process.env.CARTERA_ZIP_OUT)('prueba de cierre: el ZIP para construir la web', () => {
  it('escribe el ZIP en CARTERA_ZIP_OUT', async () => {
    const { default: sharp } = await import('sharp');
    const image = (fmt: 'jpeg' | 'png' | 'webp', r: number) =>
      sharp({ create: { width: 1600, height: 1067, channels: 3, background: { r, g: 120, b: 160 } } })
        [fmt]()
        .toBuffer();
    const site = f.addSite();
    const ids: string[] = [];
    // Los m² útiles, los de los planos a escala de la demo (src/content/escala/),
    // que siguen en el repositorio y la web cruza por referencia (checkPlan).
    for (const [op, data, status] of [
      ['venta', { ...fullVenta(), usable: 92 }, 'venta'],
      ['venta', { ...fullVenta(), title: { es: 'Casa de pueblo', en: 'Village house', de: 'Dorfhaus' }, price: 320000, usable: 141 }, 'reservada'],
      ['alquiler', { ...fullAlquiler(), usable: 80 }, 'disponible'],
    ] as const) {
      const c = await createHome(asPrisma(), site, op, ACTOR);
      if (!c.ok) throw new Error('alta');
      await saveHome(asPrisma(), site, c.id, { status, data }, ACTOR);
      ids.push(c.id);
    }
    const draft = await createHome(asPrisma(), site, 'venta', ACTOR);
    if (!draft.ok) throw new Error('alta');
    await addPhoto(site.id, ids[0], 0, 'image/jpeg', await image('jpeg', 200));
    await addPhoto(site.id, ids[0], 1, 'image/png', await image('png', 90));
    await addPhoto(site.id, ids[1], 0, 'image/webp', await image('webp', 30));
    await addPhoto(site.id, ids[2], 0, 'image/jpeg', await image('jpeg', 150));
    await addPhoto(site.id, draft.id, 0, 'image/jpeg', await image('jpeg', 10));
    // Una foto 360° en la C-101: la web la enseña si su archivo de escala la
    // nombra en panoRooms por su id (el nombre del archivo en el ZIP).
    const pano = await addPano(site.id, ids[0], 0, await sharp({ create: { width: 4096, height: 2048, channels: 3, background: { r: 90, g: 140, b: 150 } } }).jpeg().toBuffer());
    console.log(`foto 360° de la C-101: ${pano.id}`);
    const res = await exportGet(portalReq());
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    readZip(buf);
    await writeFile(process.env.CARTERA_ZIP_OUT!, buf);
  });
});
