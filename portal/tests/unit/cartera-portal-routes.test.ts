// =============================================================================
// Cartera — las rutas del panel (/api/portal/cartera/*): quién entra y qué
// puede hacer. Activa o en pausa, todo; en la gracia de una baja, solo leer
// (403 'read_only' en toda escritura); sin contratación, nada. Una casa de
// otro sitio da 404. «Traducir» propone y no escribe nada.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({
  session: { hasClientAccess: true } as { hasClientAccess: boolean },
  resolved: { source: 'database', clientId: 'client-1' } as { source: string; clientId: string } | null,
  writable: null as Record<string, unknown> | null,
  owner: null as Record<string, unknown> | null,
  homeFindFirst: vi.fn(),
  homeFindMany: vi.fn(),
  homeUpdate: vi.fn(),
  buildFindFirst: vi.fn(),
  photoFindFirst: vi.fn(),
  translate: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: async () => state.session }));
vi.mock('@/lib/portal-session', () => ({ resolveClientFromSession: async () => state.resolved }));
vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/cartera/site', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cartera/site')>()),
  findSiteForClient: async () => state.writable,
  findSiteForOwner: async () => state.owner,
}));
vi.mock('@/lib/cartera-translation-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cartera-translation-ai')>()),
  translateHomeTexts: (...a: unknown[]) => state.translate(...a),
}));
vi.mock('@/lib/prisma', () => {
  const prisma = {
    carteraHome: {
      findFirst: (...a: unknown[]) => state.homeFindFirst(...a),
      findMany: (...a: unknown[]) => state.homeFindMany(...a),
      update: (...a: unknown[]) => state.homeUpdate(...a),
    },
    carteraBuild: { findFirst: (...a: unknown[]) => state.buildFindFirst(...a) },
    carteraPhoto: { findFirst: (...a: unknown[]) => state.photoFindFirst(...a) },
    carteraAudit: { create: async () => ({}) },
    carteraSite: { updateMany: async () => ({ count: 0 }) },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return { isDatabaseConfigured: true, prisma };
});

import { GET as listGet } from '@/app/api/portal/cartera/route';
import { POST as createPost } from '@/app/api/portal/cartera/casas/route';
import { DELETE as homeDelete, GET as homeGet, PATCH as homePatch } from '@/app/api/portal/cartera/casas/[id]/route';
import { DELETE as photoDelete, PATCH as photoPatch, POST as photoPost } from '@/app/api/portal/cartera/casas/[id]/fotos/route';
import { DELETE as panoDelete, PATCH as panoPatch, POST as panoPost } from '@/app/api/portal/cartera/casas/[id]/panos/route';
import { POST as translatePost } from '@/app/api/portal/cartera/casas/[id]/traducir/route';
import { TRANSLATIONS_PER_HOUR } from '@/lib/cartera-translation-ai';

const SITE = {
  id: '11111111-1111-4111-8111-111111111111',
  clientId: 'client-1',
  feedToken: 'car_secretfeedtoken0000000',
  buildSecretHash: 'hash-del-secreto',
  siteUrl: 'https://agencia.example',
  salePrefix: 'C',
  rentPrefix: 'A',
  agents: [{ key: 'lucia', name: 'Lucía' }],
  pendingSince: null,
};
const HOME_ID = '22222222-2222-4222-8222-222222222222';
const HOME = { id: HOME_ID, siteId: SITE.id, ref: 'C-101', operation: 'venta', status: 'borrador', data: {}, errors: null, slugLocked: false, firstPublishedAt: null, updatedAt: new Date(), photos: [], panos: [] };

const params = (id = HOME_ID) => ({ params: Promise.resolve({ id }) });
const json = (url: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

function active() {
  state.writable = { ...SITE };
  state.owner = { site: { ...SITE, clientProduct: { status: 'active' } }, state: 'active', graceEndsAt: null };
}
function grace() {
  state.writable = null;
  state.owner = { site: { ...SITE, clientProduct: { status: 'cancelled' } }, state: 'grace', graceEndsAt: new Date('2026-12-19T00:00:00Z') };
}

beforeEach(() => {
  state.session = { hasClientAccess: true };
  state.resolved = { source: 'database', clientId: 'client-1' };
  for (const f of [state.homeFindFirst, state.homeFindMany, state.homeUpdate, state.buildFindFirst, state.photoFindFirst, state.translate]) f.mockReset();
  state.homeFindFirst.mockImplementation(async ({ where }: { where: { id: string; siteId: string } }) => (where.id === HOME_ID && where.siteId === SITE.id ? { ...HOME } : null));
  state.homeFindMany.mockResolvedValue([]);
  state.buildFindFirst.mockResolvedValue(null);
  active();
});

describe('acceso', () => {
  it('sin sesión de cliente: 401', async () => {
    state.session = { hasClientAccess: false };
    expect((await listGet()).status).toBe(401);
  });

  it('sin la cartera contratada: 403 not_contracted', async () => {
    state.writable = null;
    state.owner = null;
    const res = await listGet();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_contracted' });
  });

  it('el listado no enseña el token del feed ni el secreto de publicación', async () => {
    const res = await listGet();
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain(SITE.feedToken);
    expect(text).not.toContain(SITE.buildSecretHash);
    expect(text).toContain('"readOnly":false');
  });
});

describe('en la gracia de la baja: solo lectura', () => {
  beforeEach(grace);

  it('leer, sí', async () => {
    const list = await listGet();
    expect(list.status).toBe(200);
    expect((await list.json()).site.readOnly).toBe(true);
    const home = await homeGet(json(`/api/portal/cartera/casas/${HOME_ID}`, 'GET'), params());
    expect(home.status).toBe(200);
    expect((await home.json()).readOnly).toBe(true);
  });

  it('cualquier escritura: 403 read_only, sin tocar la base de datos', async () => {
    const writes = [
      () => createPost(json('/api/portal/cartera/casas', 'POST', { operation: 'venta' })),
      () => homePatch(json(`/api/portal/cartera/casas/${HOME_ID}`, 'PATCH', { data: {} }), params()),
      () => homeDelete(json(`/api/portal/cartera/casas/${HOME_ID}`, 'DELETE'), params()),
      () => photoPost(json(`/api/portal/cartera/casas/${HOME_ID}/fotos`, 'POST', {}), params()),
      () => photoPatch(json(`/api/portal/cartera/casas/${HOME_ID}/fotos`, 'PATCH', { order: [] }), params()),
      () => photoDelete(json(`/api/portal/cartera/casas/${HOME_ID}/fotos`, 'DELETE', { photoId: HOME_ID }), params()),
      () => panoPost(json(`/api/portal/cartera/casas/${HOME_ID}/panos`, 'POST', {}), params()),
      () => panoPatch(json(`/api/portal/cartera/casas/${HOME_ID}/panos`, 'PATCH', { order: [] }), params()),
      () => panoDelete(json(`/api/portal/cartera/casas/${HOME_ID}/panos`, 'DELETE', { panoId: HOME_ID }), params()),
      () => translatePost(json(`/api/portal/cartera/casas/${HOME_ID}/traducir`, 'POST', { title: 'Casa' }), params()),
    ];
    for (const write of writes) {
      const res = await write();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'read_only' });
    }
    expect(state.homeUpdate).not.toHaveBeenCalled();
    expect(state.translate).not.toHaveBeenCalled();
  });
});

describe('casas de otro sitio', () => {
  it('un id ajeno o mal formado da 404', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    expect((await homeGet(json(`/api/portal/cartera/casas/${other}`, 'GET'), params(other))).status).toBe(404);
    expect((await homePatch(json(`/api/portal/cartera/casas/${other}`, 'PATCH', { data: {} }), params(other))).status).toBe(404);
    expect((await homeDelete(json('/api/portal/cartera/casas/x', 'DELETE'), params('../../etc'))).status).toBe(404);
    expect((await photoPatch(json(`/api/portal/cartera/casas/${other}/fotos`, 'PATCH', { order: [] }), params(other))).status).toBe(404);
    expect((await panoPatch(json(`/api/portal/cartera/casas/${other}/panos`, 'PATCH', { order: [] }), params(other))).status).toBe(404);
    expect((await panoDelete(json(`/api/portal/cartera/casas/${other}/panos`, 'DELETE', { panoId: other }), params(other))).status).toBe(404);
    expect(state.homeUpdate).not.toHaveBeenCalled();
  });

  it('el cuerpo no elige el cliente ni el sitio: claves de más se rechazan', async () => {
    const res = await createPost(json('/api/portal/cartera/casas', 'POST', { operation: 'venta', siteId: 'otro', clientId: 'otro' }));
    expect(res.status).toBe(400);
  });
});

describe('fotos 360°', () => {
  /** Una JPEG mínima con sus medidas en el SOF0 (como en cartera-photos.test.ts). */
  const jpeg = (width: number, height: number) =>
    Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3]),
      Buffer.alloc(20),
    ]);
  const upload = (buf: Buffer) => {
    const form = new FormData();
    form.append('archivo', new Blob([new Uint8Array(buf)], { type: 'image/jpeg' }), 'foto-360.jpg');
    return panoPost(new NextRequest(`http://localhost/api/portal/cartera/casas/${HOME_ID}/panos`, { method: 'POST', body: form }), params());
  };

  it('una que no es 2:1 se rechaza al subir, con su código (el panel lo explica)', async () => {
    const res = await upload(jpeg(3000, 2000));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'not_equirectangular' });
  });

  it('el orden y el borrado validan el cuerpo', async () => {
    expect((await panoPatch(json(`/api/portal/cartera/casas/${HOME_ID}/panos`, 'PATCH', { order: ['no-es-un-id'] }), params())).status).toBe(400);
    expect((await panoPatch(json(`/api/portal/cartera/casas/${HOME_ID}/panos`, 'PATCH', { order: [], alt: {} }), params())).status).toBe(400);
    expect((await panoDelete(json(`/api/portal/cartera/casas/${HOME_ID}/panos`, 'DELETE', { photoId: HOME_ID }), params())).status).toBe(400);
  });
});

describe('guardar', () => {
  it('se guarda aunque falten datos y devuelve los avisos', async () => {
    state.homeUpdate.mockResolvedValue({});
    const res = await homePatch(json(`/api/portal/cartera/casas/${HOME_ID}`, 'PATCH', { data: { title: { es: 'Casa', en: '', de: '' } } }), params());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('borrador');
    expect(body.errors.length).toBeGreaterThan(0);
    expect(state.homeUpdate).toHaveBeenCalledTimes(1);
  });

  it('un estado que no es de la operación: 400', async () => {
    const res = await homePatch(json(`/api/portal/cartera/casas/${HOME_ID}`, 'PATCH', { status: 'alquilada', data: {} }), params());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_status' });
  });

  it('borrar una casa publicada: 409', async () => {
    state.homeFindFirst.mockResolvedValue({ ...HOME, status: 'venta', firstPublishedAt: new Date() });
    const res = await homeDelete(json(`/api/portal/cartera/casas/${HOME_ID}`, 'DELETE'), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_a_draft' });
  });
});

describe('traducir', () => {
  it('propone y no escribe nada', async () => {
    state.translate.mockResolvedValue({ ok: true, model: 'm', proposal: { title: { en: 'House', de: 'Haus' }, summary: null, floor: null, lacks: [], alts: [] } });
    const res = await translatePost(json(`/api/portal/cartera/casas/${HOME_ID}/traducir`, 'POST', { title: 'Casa' }), params());
    expect(res.status).toBe(200);
    expect((await res.json()).proposal.title).toEqual({ en: 'House', de: 'Haus' });
    expect(state.homeUpdate).not.toHaveBeenCalled();
  });

  it('sin texto en español, ni se llama a la IA', async () => {
    const res = await translatePost(json(`/api/portal/cartera/casas/${HOME_ID}/traducir`, 'POST', { title: ' ', lacks: [''] }), params());
    expect(res.status).toBe(400);
    expect(state.translate).not.toHaveBeenCalled();
  });

  it('sin clave de IA: 503; si la IA falla: 502', async () => {
    state.translate.mockResolvedValueOnce({ ok: true, skipped: true, reason: 'no_api_key' });
    expect((await translatePost(json(`/api/portal/cartera/casas/${HOME_ID}/traducir`, 'POST', { title: 'Casa' }), params())).status).toBe(503);
    state.translate.mockResolvedValueOnce({ ok: false, error: 'boom' });
    expect((await translatePost(json(`/api/portal/cartera/casas/${HOME_ID}/traducir`, 'POST', { title: 'Casa' }), params())).status).toBe(502);
  });

  it(`como mucho ${TRANSLATIONS_PER_HOUR} por hora y cliente`, async () => {
    state.resolved = { source: 'database', clientId: 'client-limite' };
    state.translate.mockResolvedValue({ ok: true, model: 'm', proposal: { title: null, summary: null, floor: null, lacks: [], alts: [] } });
    let last = 0;
    for (let i = 0; i <= TRANSLATIONS_PER_HOUR; i++) last = (await translatePost(json(`/api/portal/cartera/casas/${HOME_ID}/traducir`, 'POST', { title: 'Casa' }), params())).status;
    expect(last).toBe(429);
    expect(state.translate).toHaveBeenCalledTimes(TRANSLATIONS_PER_HOUR);
  });
});
