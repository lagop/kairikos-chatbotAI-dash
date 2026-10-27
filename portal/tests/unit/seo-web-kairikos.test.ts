import { describe, expect, it, vi, beforeEach } from 'vitest';

// =============================================================================
// Webs con IA, entrega 6 (27/10/2026) — el SEO sobre una web de Kairikos:
// artículos como entradas del blog, títulos y descripciones con un clic y
// Search Console verificado por el portal.
// =============================================================================

const mock = vi.hoisted(() => ({
  publishWebsite: vi.fn(),
  publishSeoDraftToWebsite: vi.fn(),
  publishDraftToWordPress: vi.fn(),
}));

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/website-publish', async (orig) => ({
  ...(await orig<typeof import('@/lib/website-publish')>()),
  publishWebsite: (...a: unknown[]) => mock.publishWebsite(...a),
}));
vi.mock('@/lib/wordpress-publish', () => ({
  hasWordPressCredentials: (p: { wordpressUrl?: string | null } | null) => Boolean(p?.wordpressUrl),
  publishDraftToWordPress: (...a: unknown[]) => mock.publishDraftToWordPress(...a),
}));

import type { PrismaClient } from '@prisma/client';
import { parseSiteContent, type SiteContent } from '@/lib/site-content';
import { SITE_CONTENT_SAMPLES, SAMPLE_RENDER_CONTEXT } from '@/lib/site-content-samples';
import { renderSiteFiles } from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { publishSeoDraftToWebsite, upsertSeoEntry, verifyWebsiteInSearchConsole } from '@/lib/website-seo-publish';
import { applyMetaProposals, pageSummaries } from '@/lib/website-meta';
import { parseWebsiteMetaResponse } from '@/lib/website-meta-ai';
import { getMetaVerificationToken, parseMetaToken } from '@/lib/google-site-verification';
import { attemptPublishDraft } from '@/lib/seo-content-review';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const content = () => clone(SITE_CONTENT_SAMPLES.normal) as SiteContent;
const DRAFT = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Cómo <b>evitar</b> atascos en casa',
  bodyHtml: '<h1>Intro</h1><p>Texto <script>alert(1)</script>útil</p><img src="https://espia.example/x.gif"><ul><li>Uno</li></ul>',
  metaDescription: 'Consejos para que no se atasque nada.',
};

beforeEach(() => {
  mock.publishWebsite.mockReset().mockResolvedValue({ ok: true, filesUploaded: 5, version: 2, url: null });
  mock.publishSeoDraftToWebsite.mockReset();
  mock.publishDraftToWordPress.mockReset();
});

describe('el artículo como entrada del blog', () => {
  it('se añade limpio, publicado y marcado como del SEO', () => {
    const { content: c, entry } = upsertSeoEntry(content(), DRAFT, '2026-10-27');
    expect(entry).toMatchObject({ slug: 'como-evitar-atascos-en-casa', titulo: 'Cómo evitar atascos en casa', origen: 'seo', publicada: true, fecha: '2026-10-27', seoDraftId: DRAFT.id });
    expect(entry.html).not.toMatch(/script|<img|<h1/);
    expect(entry.html).toContain('<h2>Intro</h2>');
    expect(c.blog.entradas[0]).toBe(entry);
    expect(parseSiteContent(c).ok).toBe(true);
  });

  it('reintentar la misma publicación actualiza la entrada, no la duplica, y conserva su dirección', () => {
    const first = upsertSeoEntry(content(), DRAFT, '2026-10-27').content;
    const { content: again, entry } = upsertSeoEntry(first, { ...DRAFT, title: 'Título retocado' }, '2026-11-02');
    expect(again.blog.entradas.filter((e) => e.seoDraftId === DRAFT.id)).toHaveLength(1);
    expect(entry).toMatchObject({ slug: 'como-evitar-atascos-en-casa', fecha: '2026-10-27', titulo: 'Título retocado' });
  });

  it('dos artículos con el mismo título no comparten dirección', () => {
    const c = upsertSeoEntry(content(), DRAFT, '2026-10-27').content;
    const { entry } = upsertSeoEntry(c, { ...DRAFT, id: '22222222-2222-4222-8222-222222222222' }, '2026-10-28');
    expect(entry.slug).toBe('como-evitar-atascos-en-casa-2');
  });

  it('el motor vuelve a limpiar el HTML al pintarlo, aunque llegue sucio por el editor', () => {
    const c = content();
    c.blog.entradas[0].html = '<p>ok</p><img src=x onerror="alert(1)"><script>robar()</script>';
    const html = renderSiteFiles(SITE_TEMPLATE_BASE, c, SAMPLE_RENDER_CONTEXT)
      .find((f) => f.path === `blog/${c.blog.entradas[0].slug}/index.html`)
      ?.content.toString('utf8');
    expect(html).toContain('<p>ok</p>');
    expect(html).not.toMatch(/onerror|robar\(\)/);
  });
});

function fakePrisma(websiteContent: unknown) {
  const state = { content: websiteContent, audits: [] as unknown[] };
  const tx = {
    clientWebsite: { update: vi.fn(async ({ data }: { data: { content: unknown } }) => (state.content = data.content)) },
    clientWebsiteAudit: { create: vi.fn(async ({ data }: { data: unknown }) => state.audits.push(data)) },
  };
  const prisma = {
    clientWebsite: {
      findUnique: vi.fn(async () => ({ id: 'w1', clientId: 'c1', tenantId: null, content: state.content, publishTarget: 'kairikos', slug: 'suarez', customDomain: 'suarez.es' })),
    },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  return { prisma: prisma as unknown as PrismaClient, state };
}

describe('publishSeoDraftToWebsite', () => {
  it('guarda la entrada, publica la web y devuelve la dirección del artículo', async () => {
    const { prisma, state } = fakePrisma(content());
    const r = await publishSeoDraftToWebsite(prisma, 'w1', DRAFT, new Date('2026-10-27T10:00:00Z'));
    expect(r).toEqual({ ok: true, slug: 'como-evitar-atascos-en-casa', url: 'https://suarez.es/blog/como-evitar-atascos-en-casa/' });
    expect((state.content as SiteContent).blog.entradas[0].seoDraftId).toBe(DRAFT.id);
    expect(state.audits[0]).toMatchObject({ action: 'seo_entry_published', actorType: 'system' });
    expect(mock.publishWebsite).toHaveBeenCalledWith(prisma, 'w1', { type: 'system', email: 'system:seo' }, expect.any(Date));
  });

  it('si la web no se puede publicar, la entrada queda guardada y se dice por qué', async () => {
    mock.publishWebsite.mockResolvedValue({ ok: false, error: 'example_data_pending' });
    const { prisma, state } = fakePrisma(content());
    const r = await publishSeoDraftToWebsite(prisma, 'w1', DRAFT);
    expect(r).toEqual({ ok: false, error: 'website_example_data_pending', savedSlug: 'como-evitar-atascos-en-casa' });
    expect((state.content as SiteContent).blog.entradas[0].seoDraftId).toBe(DRAFT.id);
  });

  it('una web de las de antes (sin contenido v2) no tiene blog', async () => {
    const { prisma } = fakePrisma(null);
    expect(await publishSeoDraftToWebsite(prisma, 'w1', DRAFT)).toEqual({ ok: false, error: 'website_not_v2' });
  });
});

describe('attemptPublishDraft con una web de Kairikos', () => {
  function reviewPrisma(profile: Record<string, unknown>) {
    const updates: Record<string, unknown>[] = [];
    const prisma = {
      seoContentDraft: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({ id: DRAFT.id, profileId: 'p1', title: DRAFT.title, bodyHtml: DRAFT.bodyHtml, metaDescription: DRAFT.metaDescription })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => updates.push(data)),
      },
      seoProfile: { findUnique: vi.fn(async () => profile) },
      clientWebsite: { findUnique: vi.fn(async () => ({ id: 'w1', clientId: 'c1', tenantId: null, content: content(), publishTarget: 'kairikos', slug: 's', customDomain: 'suarez.es' })) },
      $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn({ clientWebsite: { update: vi.fn() }, clientWebsiteAudit: { create: vi.fn() } }),
    };
    return { prisma: prisma as unknown as PrismaClient, updates };
  }

  it('publica en el blog en vez de en WordPress y guarda la dirección', async () => {
    const { prisma, updates } = reviewPrisma({ cmsType: 'kairikos', websiteId: 'w1', wordpressUrl: null });
    expect(await attemptPublishDraft(prisma, DRAFT.id, 'c1', { fromStatus: 'pending_client_review' })).toEqual({ ok: true });
    expect(mock.publishDraftToWordPress).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({ status: 'published', wordpressPostUrl: 'https://suarez.es/blog/como-evitar-atascos-en-casa/', wordpressPostId: null });
  });

  it('sin web enlazada, falla con un motivo claro', async () => {
    const { prisma, updates } = reviewPrisma({ cmsType: 'kairikos', websiteId: null });
    expect(await attemptPublishDraft(prisma, DRAFT.id, 'c1', { fromStatus: 'pending_client_review' })).toEqual({ ok: false, error: 'missing_kairikos_website' });
    expect(updates.at(-1)).toMatchObject({ status: 'publish_failed', publishError: 'missing_kairikos_website' });
  });
});

describe('títulos y descripciones con un clic', () => {
  it('cada página se resume con lo que enseña', () => {
    const c = content();
    c.paginas.push({ ruta: 'desatascos', titulo: 'Desatascos', metaTitulo: '', metaDescripcion: '', secciones: [{ tipo: 'servicios' }, { tipo: 'faq', oculta: true }] });
    const [home, sub] = pageSummaries(c);
    expect(home.resumen).toContain('Localizamos la avería');
    expect(sub).toMatchObject({ ruta: 'desatascos', titulo: 'Desatascos' });
    expect(sub.resumen).toMatch(/^Servicios: /);
    expect(sub.resumen).not.toContain('Preguntas');
  });

  it('la respuesta de la IA: sin valla, solo rutas que existen, recortada', () => {
    const text = '```json\n[{"ruta":"","metaTitulo":"' + 'x'.repeat(80) + '","metaDescripcion":"Desc"},{"ruta":"inventada","metaTitulo":"t","metaDescripcion":"d"},{"ruta":"/desatascos/","metaTitulo":"Desatascos en Telde","metaDescripcion":""}]\n```';
    const r = parseWebsiteMetaResponse(text, ['', 'desatascos']);
    expect(r).toEqual([
      { ruta: '', metaTitulo: 'x'.repeat(60), metaDescripcion: 'Desc' },
      { ruta: 'desatascos', metaTitulo: 'Desatascos en Telde', metaDescripcion: '' },
    ]);
    expect(parseWebsiteMetaResponse('no es json', [''])).toBeNull();
  });

  it('aplicar escribe en las páginas que existen y dice cuáles cambiaron', () => {
    const { content: c, changed } = applyMetaProposals(content(), [
      { ruta: '', metaTitulo: 'Fontanero en Las Palmas · Fontanería Ejemplo', metaDescripcion: 'Urgencias y reparaciones.' },
      { ruta: 'borrada', metaTitulo: 'x', metaDescripcion: 'y' },
    ]);
    expect(changed).toEqual(['/']);
    expect(c.paginas[0].metaTitulo).toBe('Fontanero en Las Palmas · Fontanería Ejemplo');
  });
});

describe('Search Console sin tocar nada', () => {
  it('lee el código de la etiqueta que devuelve Google', () => {
    expect(parseMetaToken('<meta name="google-site-verification" content="AbC_123-xyzLongToken" />')).toBe('AbC_123-xyzLongToken');
    expect(parseMetaToken('<meta content="mal"/>')).toBeNull();
  });

  it('pide el código a la API de verificación con el método META', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ method: 'META', token: '<meta name="google-site-verification" content="TokenDePrueba123" />' })));
    vi.stubGlobal('fetch', fetchMock);
    const r = await getMetaVerificationToken('acc', 'https://suarez.es/');
    vi.unstubAllGlobals();
    expect(r).toEqual({ ok: true, value: 'TokenDePrueba123' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/siteVerification/v1/token');
    expect(JSON.parse(String(init.body))).toEqual({ verificationMethod: 'META', site: { type: 'SITE', identifier: 'https://suarez.es/' } });
  });

  it('pone la etiqueta, publica, verifica y añade la propiedad, en ese orden; la portada la lleva', async () => {
    const { prisma, state } = fakePrisma(content());
    const order: string[] = [];
    mock.publishWebsite.mockImplementation(async () => (order.push('publish'), { ok: true, filesUploaded: 5, version: 2, url: null }));
    const r = await verifyWebsiteInSearchConsole(prisma, 'w1', 'acc', 'https://suarez.es/', {
      getToken: async () => (order.push('token'), { ok: true, value: 'TokenDePrueba123' }),
      verify: async () => (order.push('verify'), { ok: true }),
      addSite: async () => (order.push('add'), { ok: true }),
    });
    expect(r).toEqual({ ok: true });
    expect(order).toEqual(['token', 'publish', 'verify', 'add']);
    const saved = state.content as SiteContent;
    expect(saved.verificacionGoogle).toBe('TokenDePrueba123');
    const home = renderSiteFiles(SITE_TEMPLATE_BASE, saved, { ...SAMPLE_RENDER_CONTEXT, borrador: false })[0].content.toString('utf8');
    expect(home).toContain('<meta name="google-site-verification" content="TokenDePrueba123">');
  });

  it('si la web no se publica, no se le pide a Google que verifique', async () => {
    mock.publishWebsite.mockResolvedValue({ ok: false, error: 'legal_data_missing' });
    const { prisma } = fakePrisma(content());
    const verify = vi.fn();
    const r = await verifyWebsiteInSearchConsole(prisma, 'w1', 'acc', 'https://suarez.es/', {
      getToken: async () => ({ ok: true, value: 'TokenDePrueba123' }),
      verify,
      addSite: vi.fn(),
    });
    expect(r).toEqual({ ok: false, error: 'website_legal_data_missing' });
    expect(verify).not.toHaveBeenCalled();
  });
});
