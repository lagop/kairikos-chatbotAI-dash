import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { MAX_IMAGES_PER_WEBSITE, MAX_UPLOAD_BYTES, inspectImage, storeWebsiteImage } from '@/lib/site-uploads';
import { SITE_UPLOAD_PATH_RE, parseSiteContent, referencedUploads } from '@/lib/site-content';
import { SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';

const PUBLIC = join(process.cwd(), 'public');
const jpg = readFileSync(join(PUBLIC, 'web-draft', 'oficios', 'fontaneria-1.jpg'));
const png = readFileSync(join(PUBLIC, 'icons', 'icon-192.png'));

/** Una cabecera WebP sin pérdida (VP8L) de 300×120: lo único que se lee. */
function webpHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8L', 12, 'ascii');
  b.writeUInt32LE(20, 16);
  b[20] = 0x2f;
  b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
  return b;
}

describe('inspectImage', () => {
  it('reconoce JPEG, PNG y WebP por sus bytes y lee sus medidas', () => {
    expect(inspectImage(jpg)).toEqual({ ext: 'jpg', contentType: 'image/jpeg', width: 1600, height: 1200 });
    expect(inspectImage(png)).toEqual({ ext: 'png', contentType: 'image/png', width: 192, height: 192 });
    expect(inspectImage(webpHeader(300, 120))).toEqual({ ext: 'webp', contentType: 'image/webp', width: 300, height: 120 });
  });

  it('rechaza lo que no es una de esas tres, aunque se llame .png', () => {
    // Un SVG puede llevar JavaScript, y la web alojada se sirve desde nuestro dominio.
    expect(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'))).toBeNull();
    expect(inspectImage(Buffer.from('GIF89a' + 'x'.repeat(40)))).toBeNull();
    expect(inspectImage(Buffer.alloc(64))).toBeNull();
    expect(inspectImage(Buffer.from([0xff, 0xd8, 0x00, 0x00, ...Buffer.alloc(40)]))).toBeNull();
  });
});

function fakePrisma(existing: { id: string; path: string; createdAt: Date }[] = []) {
  const rows = [...existing];
  const prisma = {
    clientWebsiteImage: {
      count: vi.fn(async () => rows.length),
      findMany: vi.fn(async ({ where, take }: { where: { path: { notIn: string[] } }; take: number }) =>
        rows.filter((r) => !where.path.notIn.includes(r.path)).sort((a, b) => +a.createdAt - +b.createdAt).slice(0, take),
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const id of where.id.in) rows.splice(rows.findIndex((r) => r.id === id), 1);
        return { count: where.id.in.length };
      }),
      create: vi.fn(async ({ data }: { data: { path: string } }) => {
        rows.push({ id: `n${rows.length}`, path: data.path, createdAt: new Date() });
        return data;
      }),
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows };
}

describe('storeWebsiteImage', () => {
  const website = { id: 'w1', content: SITE_CONTENT_SAMPLES.normal };

  it('guarda con un nombre que pone el servidor y que el contenido acepta', async () => {
    const { prisma } = fakePrisma();
    const r = await storeWebsiteImage(prisma, website, jpg);
    expect(r).toMatchObject({ ok: true, width: 1600, height: 1200 });
    expect(r.ok && SITE_UPLOAD_PATH_RE.test(r.path)).toBe(true);
    expect(r.ok && r.path.endsWith('.jpg')).toBe(true);
  });

  it('rechaza lo pesado, lo que no es imagen y lo enorme', async () => {
    const { prisma } = fakePrisma();
    expect(await storeWebsiteImage(prisma, website, Buffer.concat([jpg, Buffer.alloc(MAX_UPLOAD_BYTES)]))).toEqual({ ok: false, error: 'too_large' });
    expect(await storeWebsiteImage(prisma, website, Buffer.from('<svg></svg>'.padEnd(64)))).toEqual({ ok: false, error: 'not_an_image' });
    expect(await storeWebsiteImage(prisma, website, webpHeader(5000, 300))).toEqual({ ok: false, error: 'too_big_dimensions' });
  });

  it('al llegar al tope recoge la más vieja que no se usa, nunca una que cita el contenido', async () => {
    const used = 'assets/subidas/aaaaaaaaaaaaaaaaaa.jpg';
    const content = { ...SITE_CONTENT_SAMPLES.normal, imagenes: { logo: used, portada: '' } };
    const rows = Array.from({ length: MAX_IMAGES_PER_WEBSITE }, (_, i) => ({
      id: `r${i}`,
      path: i === 0 ? used : `assets/subidas/${String(i).padStart(18, 'b')}.jpg`,
      createdAt: new Date(2026, 9, 1, 0, i),
    }));
    const { prisma, rows: after } = fakePrisma(rows);
    expect(await storeWebsiteImage(prisma, { id: 'w1', content }, jpg)).toMatchObject({ ok: true });
    expect(after.some((r) => r.path === used)).toBe(true);
    expect(after.some((r) => r.id === 'r1')).toBe(false);
    expect(after).toHaveLength(MAX_IMAGES_PER_WEBSITE);
  });

  it('si todas están en uso, no sube más', async () => {
    const paths = Array.from({ length: MAX_IMAGES_PER_WEBSITE }, (_, i) => `assets/subidas/${String(i).padStart(18, 'c')}.jpg`);
    const content = {
      ...SITE_CONTENT_SAMPLES.normal,
      bloques: paths.map((foto, i) => ({ id: `b${i}`, tipo: 'texto_foto' as const, titulo: 'x', texto: '', foto, fotoAlt: '', items: [] })),
    };
    const { prisma } = fakePrisma(paths.map((path, i) => ({ id: `r${i}`, path, createdAt: new Date() })));
    expect(await storeWebsiteImage(prisma, { id: 'w1', content }, jpg)).toEqual({ ok: false, error: 'too_many_images' });
  });
});

describe('imágenes en el contenido', () => {
  it('logo y portada solo admiten rutas de subidas, nunca una URL ajena', () => {
    const ok = parseSiteContent({ ...SITE_CONTENT_SAMPLES.normal, imagenes: { logo: 'assets/subidas/0123456789abcdef01.png', portada: '' } });
    expect(ok.ok).toBe(true);
    for (const bad of ['https://otra-web.com/logo.png', '../../etc/passwd', 'assets/subidas/x.svg', 'assets/portada.jpg']) {
      expect(parseSiteContent({ ...SITE_CONTENT_SAMPLES.normal, imagenes: { logo: bad, portada: '' } }).ok).toBe(false);
    }
    // Un contenido de antes, sin el campo, sigue valiendo.
    const old = { ...SITE_CONTENT_SAMPLES.normal } as Record<string, unknown>;
    delete old.imagenes;
    const parsed = parseSiteContent(old);
    expect(parsed.ok && parsed.content.imagenes).toEqual({ logo: '', portada: '' });
  });

  it('las citadas son las del logo, la portada, los bloques y las entradas, sin repetir', () => {
    const a = 'assets/subidas/aaaaaaaaaaaaaaaaaa.webp';
    const b = 'assets/subidas/bbbbbbbbbbbbbbbbbb.jpg';
    expect(
      referencedUploads({
        imagenes: { logo: a, portada: '' },
        bloques: [{ foto: b }, { foto: 'https://ajena.com/x.jpg' }, { foto: a }],
        blog: { entradas: [{ foto: '' }] },
      }),
    ).toEqual([a, b]);
  });
});
