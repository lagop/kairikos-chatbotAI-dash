// =============================================================================
// Cartera — las fotos al subirlas (lib/cartera/photos.ts): el tipo se decide
// por los primeros bytes (JPEG, PNG o WebP; nunca SVG ni lo que diga el
// navegador), hasta 3 MB, 2.400 px por lado y 40 por casa. El fichero va al
// volumen y, si la fila no se puede crear, no se queda huérfano.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_PHOTOS_PER_HOME, checkPhoto, cleanAlt, isSamePhotoSet, readPhotoUpload, storeHomePhoto } from '@/lib/cartera/photos';

const SITE_ID = '11111111-1111-4111-8111-111111111111';
const HOME_ID = '22222222-2222-4222-8222-222222222222';

function png(width: number, height: number, size = 33): Buffer {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
function jpeg(width: number, height: number): Buffer {
  // SOI, un APP0 vacío y el SOF0 con alto y ancho.
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3]),
    Buffer.alloc(20),
  ]);
}
function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(34);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(26, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

describe('checkPhoto: el tipo por los bytes', () => {
  it('acepta JPEG, PNG y WebP con sus medidas', () => {
    expect(checkPhoto(jpeg(2400, 1600))).toMatchObject({ ok: true, info: { contentType: 'image/jpeg', width: 2400, height: 1600 } });
    expect(checkPhoto(png(1200, 900))).toMatchObject({ ok: true, info: { contentType: 'image/png', width: 1200, height: 900 } });
    expect(checkPhoto(webp(1600, 1067))).toMatchObject({ ok: true, info: { contentType: 'image/webp', width: 1600, height: 1067 } });
  });

  it('rechaza SVG, HTML, GIF y basura, se llamen como se llamen', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');
    const html = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)]);
    for (const bad of [svg, html, gif, Buffer.alloc(64), Buffer.alloc(4)]) expect(checkPhoto(bad)).toEqual({ ok: false, error: 'not_an_image' });
  });

  it('como mucho 3 MB y 2.400 px por lado', () => {
    expect(checkPhoto(png(1000, 1000, 3_000_001))).toEqual({ ok: false, error: 'too_large' });
    expect(checkPhoto(png(1000, 1000, 3_000_000)).ok).toBe(true);
    expect(checkPhoto(png(2401, 1000))).toEqual({ ok: false, error: 'too_big_dimensions' });
    expect(checkPhoto(jpeg(1000, 2401))).toEqual({ ok: false, error: 'too_big_dimensions' });
    expect(checkPhoto(png(0, 1000))).toEqual({ ok: false, error: 'not_an_image' });
  });
});

describe('readPhotoUpload', () => {
  it('rechaza por la cabecera un cuerpo enorme sin leerlo', async () => {
    const req = new Request('http://localhost/x', { method: 'POST', headers: { 'content-length': String(10_000_000) }, body: 'x' });
    expect(await readPhotoUpload(req)).toEqual({ ok: false, status: 413, error: 'too_large' });
  });

  it('exige el campo «archivo» con un fichero', async () => {
    const form = new FormData();
    form.append('archivo', 'texto');
    expect(await readPhotoUpload(new Request('http://localhost/x', { method: 'POST', body: form }))).toMatchObject({ ok: false, error: 'invalid_body' });
  });
});

describe('storeHomePhoto: volumen y fila', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cartera-store-'));
    process.env.CARTERA_FOTOS_DIR = dir;
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.CARTERA_FOTOS_DIR;
  });

  function db(count: number, opts: { failCreate?: boolean } = {}) {
    const created: Array<Record<string, unknown>> = [];
    return {
      created,
      carteraPhoto: {
        count: async () => count,
        findFirst: async () => (count ? { position: count - 1 } : null),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (opts.failCreate) throw new Error('db down');
          created.push(data);
          return data;
        },
      },
    };
  }

  it('escribe el fichero bajo <sitio>/<casa>/ y crea la fila al final del orden', async () => {
    const fake = db(2);
    const r = await storeHomePhoto(fake as never, { id: HOME_ID, siteId: SITE_ID }, jpeg(1600, 1200));
    expect(r).toMatchObject({ ok: true, photo: { width: 1600, height: 1200, position: 2, mime: 'image/jpeg' } });
    expect(fake.created[0]).toMatchObject({ homeId: HOME_ID, mime: 'image/jpeg', position: 2 });
    expect(String(fake.created[0].storageKey)).toMatch(new RegExp(`^${SITE_ID}/${HOME_ID}/[0-9a-f-]{36}\\.jpg$`));
    expect(String(fake.created[0].sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(path.join(dir, SITE_ID, HOME_ID))).toHaveLength(1);
  });

  it(`no pasa de ${MAX_PHOTOS_PER_HOME} por casa`, async () => {
    expect(await storeHomePhoto(db(MAX_PHOTOS_PER_HOME) as never, { id: HOME_ID, siteId: SITE_ID }, jpeg(800, 600))).toEqual({ ok: false, error: 'too_many_photos' });
  });

  it('si la fila falla, el fichero se borra', async () => {
    const before = readdirSync(path.join(dir, SITE_ID, HOME_ID)).length;
    await expect(storeHomePhoto(db(0, { failCreate: true }) as never, { id: HOME_ID, siteId: SITE_ID }, png(800, 600))).rejects.toThrow('db down');
    expect(readdirSync(path.join(dir, SITE_ID, HOME_ID))).toHaveLength(before);
  });

  it('lo que no es una foto ni toca el volumen', async () => {
    const before = readdirSync(path.join(dir, SITE_ID, HOME_ID)).length;
    expect(await storeHomePhoto(db(0) as never, { id: HOME_ID, siteId: SITE_ID }, Buffer.from('<svg></svg>'.padEnd(64)))).toEqual({ ok: false, error: 'not_an_image' });
    expect(readdirSync(path.join(dir, SITE_ID, HOME_ID))).toHaveLength(before);
  });

  it('sin volumen configurado, no guarda', async () => {
    const saved = process.env.CARTERA_FOTOS_DIR;
    delete process.env.CARTERA_FOTOS_DIR;
    try {
      expect(await storeHomePhoto(db(0) as never, { id: HOME_ID, siteId: SITE_ID }, png(800, 600))).toEqual({ ok: false, error: 'storage_not_configured' });
    } finally {
      process.env.CARTERA_FOTOS_DIR = saved;
    }
  });
});

describe('orden y texto alternativo', () => {
  it('el orden nuevo nombra exactamente las fotos de la casa', () => {
    expect(isSamePhotoSet(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
    expect(isSamePhotoSet(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    expect(isSamePhotoSet(['a', 'b'], ['a', 'b', 'x'])).toBe(false);
    expect(isSamePhotoSet(['a', 'b'], ['a', 'a'])).toBe(false);
  });

  it('solo los idiomas con texto, recortados', () => {
    expect(cleanAlt({ es: '  Salón ', en: '', de: 'x'.repeat(400), fr: 'nope' })).toEqual({ es: 'Salón', de: 'x'.repeat(300) });
    expect(cleanAlt(null)).toEqual({});
  });
});
