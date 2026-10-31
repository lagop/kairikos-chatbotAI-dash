import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  MAX_IMAGES_PER_DRAFT,
  copyDraftImagesToWebsite,
  draftUploadsBase,
  serveDraftImage,
  storeDraftImage,
  uploadDraftImage,
  withDraftUploadsBase,
} from '@/lib/web-draft-images';
import { SITE_UPLOAD_PATH_RE } from '@/lib/site-content';

const png = readFileSync(join(process.cwd(), 'public', 'icons', 'icon-192.png'));
const TOKEN = 'a'.repeat(64);
const LEAD = '11111111-1111-4111-8111-111111111111';
const FOTO = 'assets/subidas/0123456789abcdef01.webp';
const LOGO = 'assets/subidas/abcdefabcdefabcdef.png';

describe('withDraftUploadsBase — dónde se ven las fotos del borrador', () => {
  const base = draftUploadsBase(TOKEN);

  it('escribe las subidas bajo /borrador/<testigo>/, en src, srcset y url() de CSS', () => {
    const html = `<img src="${FOTO}"><img srcset="${FOTO} 1x, ${LOGO} 2x"><div style="background:url(${FOTO})"></div><img src='${LOGO}'>`;
    expect(withDraftUploadsBase(html, base)).toBe(
      `<img src="${base}${FOTO}"><img srcset="${base}${FOTO} 1x, ${base}${LOGO} 2x"><div style="background:url(${base}${FOTO})"></div><img src='${base}${LOGO}'>`,
    );
  });

  // /borrador/<testigo> no lleva barra final: una ruta relativa iría a
  // /borrador/assets/…, que no existe.
  it('la base es absoluta y termina en barra', () => {
    expect(base).toBe(`/borrador/${TOKEN}/`);
  });

  it('no toca las fotos de muestra, las ya absolutas ni otros textos', () => {
    const html = `<img src="/web-draft/oficios/fontaneria-1.jpg"><img src="${base}${FOTO}"><p>assets/subidas es una carpeta</p>`;
    expect(withDraftUploadsBase(html, base)).toBe(html);
  });

  it('pintar dos veces no cambia nada', () => {
    const once = withDraftUploadsBase(`<img src="${FOTO}">`, base);
    expect(withDraftUploadsBase(once, base)).toBe(once);
  });
});

function draftImagesMock() {
  return {
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({}),
    findFirst: vi.fn().mockResolvedValue(null),
  };
}

describe('storeDraftImage', () => {
  let images: ReturnType<typeof draftImagesMock>;
  let prisma: PrismaClient;
  beforeEach(() => {
    images = draftImagesMock();
    prisma = { prospectingWebDraftImage: images } as unknown as PrismaClient;
  });

  it('guarda una imagen de verdad con el nombre que pone el servidor', async () => {
    const result = await storeDraftImage(prisma, { id: 'd1', content: {} }, png);
    expect(result).toMatchObject({ ok: true, width: 192, height: 192 });
    if (!result.ok) throw new Error('no');
    expect(SITE_UPLOAD_PATH_RE.test(result.path)).toBe(true);
    expect(images.create.mock.calls[0][0].data).toMatchObject({ draftId: 'd1', path: result.path, contentType: 'image/png' });
  });

  it('rechaza lo que no es una imagen sin tocar la base', async () => {
    expect(await storeDraftImage(prisma, { id: 'd1', content: {} }, Buffer.from('<svg onload="x"></svg>'.padEnd(64)))).toEqual({ ok: false, error: 'not_an_image' });
    expect(images.create).not.toHaveBeenCalled();
  });

  it('en el tope recoge las que el contenido no cita, nunca las citadas', async () => {
    images.count.mockResolvedValue(MAX_IMAGES_PER_DRAFT);
    images.findMany.mockResolvedValue([{ id: 'vieja' }]);
    await storeDraftImage(prisma, { id: 'd1', content: { imagenes: { portada: FOTO, logo: '' } } }, png);
    expect(images.findMany.mock.calls[0][0].where).toEqual({ draftId: 'd1', path: { notIn: [FOTO] } });
    expect(images.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['vieja'] } } });
    expect(images.create).toHaveBeenCalled();
  });

  it('si todas las del tope están citadas, no guarda', async () => {
    images.count.mockResolvedValue(MAX_IMAGES_PER_DRAFT);
    images.findMany.mockResolvedValue([]);
    expect(await storeDraftImage(prisma, { id: 'd1', content: {} }, png)).toEqual({ ok: false, error: 'too_many_images' });
    expect(images.create).not.toHaveBeenCalled();
  });
});

describe('uploadDraftImage', () => {
  const findUnique = vi.fn();
  const prisma = { prospectingWebDraft: { findUnique } } as unknown as PrismaClient;
  const req = () => new Request('http://x/images', { method: 'POST', body: new FormData() });
  beforeEach(() => findUnique.mockReset());

  it('404 con un id que no es de un prospecto o sin borrador', async () => {
    expect((await uploadDraftImage(prisma, 'no-uuid', req())).status).toBe(404);
    findUnique.mockResolvedValue(null);
    expect((await uploadDraftImage(prisma, LEAD, req())).status).toBe(404);
  });

  it('409 en un borrador del diseño antiguo: no tiene dónde ponerla', async () => {
    findUnique.mockResolvedValue({ id: 'd1', content: null, templateId: null });
    expect(await uploadDraftImage(prisma, LEAD, req())).toEqual({ status: 409, body: { error: 'old_design' } });
  });

  it('400 sin archivo', async () => {
    findUnique.mockResolvedValue({ id: 'd1', content: {}, templateId: 't1' });
    expect(await uploadDraftImage(prisma, LEAD, req())).toEqual({ status: 400, body: { error: 'invalid_body' } });
  });
});

describe('serveDraftImage', () => {
  it('solo rutas de subida, y buscadas dentro del borrador pedido', async () => {
    const images = draftImagesMock();
    const prisma = { prospectingWebDraftImage: images } as unknown as PrismaClient;
    expect((await serveDraftImage(prisma, { shareToken: TOKEN }, '../../etc/passwd')).status).toBe(404);
    expect(images.findFirst).not.toHaveBeenCalled();

    images.findFirst.mockResolvedValue({ contentType: 'image/webp', content: Buffer.from('abc') });
    const res = await serveDraftImage(prisma, { shareToken: TOKEN }, FOTO);
    expect(images.findFirst.mock.calls[0][0].where).toEqual({ path: FOTO, draft: { shareToken: TOKEN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});

describe('copyDraftImagesToWebsite — las fotos pasan a la web comprada', () => {
  it('copia las que cita el contenido, con la misma ruta', async () => {
    const tx = {
      prospectingWebDraftImage: {
        findMany: vi.fn().mockResolvedValue([{ path: FOTO, contentType: 'image/webp', content: Buffer.from('x'), width: 10, height: 5 }]),
      },
      clientWebsiteImage: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const content = { imagenes: { logo: '', portada: FOTO }, bloques: [] };
    const n = await copyDraftImagesToWebsite(tx as unknown as Prisma.TransactionClient, { leadId: LEAD }, 'w1', content);
    expect(n).toBe(1);
    expect(tx.prospectingWebDraftImage.findMany.mock.calls[0][0].where).toEqual({ draft: { leadId: LEAD }, path: { in: [FOTO] } });
    expect(tx.clientWebsiteImage.createMany.mock.calls[0][0]).toEqual({
      data: [{ websiteId: 'w1', path: FOTO, contentType: 'image/webp', content: Buffer.from('x'), width: 10, height: 5 }],
      skipDuplicates: true,
    });
  });

  it('sin fotos citadas no consulta nada', async () => {
    const tx = { prospectingWebDraftImage: { findMany: vi.fn() }, clientWebsiteImage: { createMany: vi.fn() } };
    expect(await copyDraftImagesToWebsite(tx as unknown as Prisma.TransactionClient, { leadId: LEAD }, 'w1', { imagenes: { logo: '', portada: '' } })).toBe(0);
    expect(tx.prospectingWebDraftImage.findMany).not.toHaveBeenCalled();
  });
});
