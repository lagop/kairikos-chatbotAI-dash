import { describe, expect, it, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  session: null as null | { clientId: string; source: string },
  website: null as null | Record<string, unknown>,
  updates: [] as unknown[],
  audits: [] as unknown[],
  template: null as null | { estado: string },
  operatorAuth: { ok: true, operatorId: 'op1' } as { ok: boolean; operatorId?: string },
}));

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/portal-session', () => ({ resolveClientFromSession: async () => state.session }));
vi.mock('@/lib/operator-session', () => ({ authenticateAdminRequest: async () => state.operatorAuth }));
vi.mock('@/lib/prisma', () => {
  const tx = {
    clientWebsite: { update: async (a: unknown) => state.updates.push(a) },
    clientWebsiteAudit: { create: async (a: unknown) => state.audits.push(a) },
  };
  return {
    isDatabaseConfigured: true,
    prisma: {
      clientWebsite: {
        findFirst: async ({ where }: { where: { clientId: string } }) => (state.website && where.clientId === state.website.clientId ? state.website : null),
        findUnique: async () => state.website,
      },
      siteTemplate: { findUnique: async () => state.template },
      operator: { findUnique: async () => ({ email: 'op@kairikos.com' }) },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

import { NextRequest } from 'next/server';
import { PATCH as patchContent } from '@/app/api/portal/website/[clientProductId]/content/route';
import { POST as postDesign } from '@/app/api/admin/portal/websites/[websiteId]/design/route';
import { SITE_CONTENT_SAMPLES, SAMPLE_RENDER_CONTEXT } from '@/lib/site-content-samples';
import { renderSiteFiles, type SiteTemplateSource } from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { legalDataMissing } from '@/lib/site-content';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const params = (v: Record<string, string>) => ({ params: Promise.resolve(v) as never });
const req = (body: unknown) => new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  state.session = { clientId: 'c1', source: 'database' };
  state.website = { id: 'w1', clientId: 'c1', tenantId: null, content: clone(SITE_CONTENT_SAMPLES.normal), copy: { headline: 'Hola', subheadline: '', about: '', services: [{ name: 'S', description: '' }], callToAction: '' }, templateId: null };
  state.updates = [];
  state.audits = [];
  state.template = null;
  state.operatorAuth = { ok: true, operatorId: 'op1' };
});

describe('páginas legales', () => {
  const ctx = { ...SAMPLE_RENDER_CONTEXT, borrador: false, legales: true };
  // Sin blog: aquí se miran las legales (el blog tiene sus pruebas en site-blog.test.ts).
  const sinBlog = { ...SITE_CONTENT_SAMPLES.normal, blog: { ...SITE_CONTENT_SAMPLES.normal.blog, entradas: [] } };

  it('una web publicada lleva aviso legal, privacidad y cookies, con los datos del titular', () => {
    const files = renderSiteFiles(SITE_TEMPLATE_BASE, sinBlog, ctx);
    expect(files.map((f) => f.path)).toEqual(['index.html', 'aviso-legal/index.html', 'privacidad/index.html', 'cookies/index.html']);
    const aviso = files[1].content.toString('utf8');
    expect(aviso).toContain('B00000000');
    expect(aviso).toContain('<title>Aviso legal · Fontanería Ejemplo</title>');
    // Su menú lleva a las secciones de la portada, subiendo de nivel.
    expect(aviso).toContain('href="../#servicios"');
    // Y el pie de toda página enlaza a las tres.
    expect(files[0].content.toString('utf8')).toContain('<a href="aviso-legal/">Aviso legal</a>');
    expect(files[3].content.toString('utf8')).toContain('no utiliza cookies');
  });

  it('si la plantilla no pone los enlaces legales en su pie, los pone el motor', () => {
    const sinLegales: SiteTemplateSource = { ...SITE_TEMPLATE_BASE, marco: SITE_TEMPLATE_BASE.marco.replace(/\{\{#legales\}\}[\s\S]*?\{\{\/legales\}\}/, '') };
    const html = renderSiteFiles(sinLegales, SITE_CONTENT_SAMPLES.normal, ctx)[0].content.toString('utf8');
    expect(html).toMatch(/<nav class="legales"[^>]*><a href="aviso-legal\/"/);
  });

  it('el borrador no lleva páginas legales', () => {
    expect(renderSiteFiles(SITE_TEMPLATE_BASE, sinBlog, SAMPLE_RENDER_CONTEXT)).toHaveLength(1);
  });

  it('sabe qué datos legales faltan', () => {
    expect(legalDataMissing({ titular: 'X', nif: '', domicilio: ' ', email: 'a@b.es', registro: '' })).toEqual(['nif', 'domicilio']);
  });
});

describe('PATCH /api/portal/website/[id]/content', () => {
  it('guarda el contenido validado, el teléfono, y audita metadatos', async () => {
    const content = clone(SITE_CONTENT_SAMPLES.normal);
    content.ejemplos = [];
    content.paginas[0].secciones[3] = { ...content.paginas[0].secciones[3], oculta: true };
    const res = await patchContent(req({ content, phone: '600 11 22 33' }), params({ clientProductId: 'cp1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ejemplosPendientes: 0, datosLegalesQueFaltan: [] });
    expect((state.updates[0] as { data: { phone: string } }).data.phone).toBe('600 11 22 33');
    const audit = state.audits[0] as { data: { after: Record<string, unknown>; actorEmail: string } };
    expect(audit.data.after).toMatchObject({ version: 2, ejemplosPendientes: 0, datosLegalesCompletos: true });
    expect(audit.data.actorEmail).toBe('client:c1');
  });

  it('no deja guardar la web de otro, ni sin sesión, ni contenido que no valida', async () => {
    state.session = { clientId: 'otro', source: 'database' };
    expect((await patchContent(req({ content: SITE_CONTENT_SAMPLES.normal }), params({ clientProductId: 'cp1' }))).status).toBe(404);
    state.session = null;
    expect((await patchContent(req({ content: SITE_CONTENT_SAMPLES.normal }), params({ clientProductId: 'cp1' }))).status).toBe(401);
    state.session = { clientId: 'c1', source: 'database' };
    expect((await patchContent(req({ content: { version: 2, paginas: [] } }), params({ clientProductId: 'cp1' }))).status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });

  it('una web de las de antes no se edita por aquí', async () => {
    (state.website as Record<string, unknown>).content = null;
    expect((await patchContent(req({ content: SITE_CONTENT_SAMPLES.normal }), params({ clientProductId: 'cp1' }))).status).toBe(409);
  });
});

describe('POST /api/admin/portal/websites/[id]/design', () => {
  it('pasa una web de las de antes al contenido v2 con la plantilla base', async () => {
    (state.website as Record<string, unknown>).content = null;
    const res = await postDesign(req({ accion: 'convertir' }), params({ websiteId: 'w1' }));
    expect(res.status).toBe(200);
    const data = (state.updates[0] as { data: { content: { datos: { titular: string } }; templateId: null } }).data;
    expect(data.content.datos.titular).toBe('Hola');
    expect(data.templateId).toBeNull();
    expect((state.audits[0] as { data: { action: string; actorType: string } }).data).toMatchObject({ action: 'design_updated', actorType: 'operator' });
  });

  it('solo pone plantillas aprobadas, y solo a webs v2', async () => {
    state.template = { estado: 'lista' };
    expect((await postDesign(req({ accion: 'plantilla', templateId: '11111111-1111-4111-8111-111111111111' }), params({ websiteId: 'w1' }))).status).toBe(409);
    state.template = { estado: 'aprobada' };
    expect((await postDesign(req({ accion: 'plantilla', templateId: '11111111-1111-4111-8111-111111111111' }), params({ websiteId: 'w1' }))).status).toBe(200);
    (state.website as Record<string, unknown>).content = null;
    expect((await postDesign(req({ accion: 'plantilla', templateId: null }), params({ websiteId: 'w1' }))).status).toBe(409);
  });

  it('sin sesión de operador, nada', async () => {
    state.operatorAuth = { ok: false };
    expect((await postDesign(req({ accion: 'convertir' }), params({ websiteId: 'w1' }))).status).toBe(401);
  });
});
