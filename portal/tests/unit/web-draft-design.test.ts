import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ pick: vi.fn(), expand: vi.fn() }));

vi.mock('@/lib/observability', () => ({ logError: vi.fn() }));
vi.mock('@/lib/site-template-jobs', () => ({ pickSiteTemplateForSector: (...a: unknown[]) => mocks.pick(...a) }));
vi.mock('@/lib/site-content-ai', async (orig) => ({
  ...(await orig<typeof import('@/lib/site-content-ai')>()),
  expandDraftToSiteContent: (...a: unknown[]) => mocks.expand(...a),
}));

import type { PrismaClient } from '@prisma/client';
import { buildSiteContentFromDraft, parseExpansionResponse } from '@/lib/site-content-ai';
import { renderResenasHtml, renderCitasHtml } from '@/lib/site-draft-markup';
import { designForDraft, draftBannerHtml, draftOfferHtml, draftRenderContext, renderDesignedDraft, templateIconIds } from '@/lib/web-draft-design';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { validateSiteTemplate } from '@/lib/site-template-validate';
import type { WebDraftCopy } from '@/lib/web-draft-ai';

const COPY: WebDraftCopy = {
  headline: 'Localizamos la avería sin romperle la casa',
  subheadline: 'Fugas, desatascos y termos.',
  about: 'Fontanero de barrio.',
  services: [
    { name: 'Detección de fugas', description: 'Sin abrir de más.' },
    { name: 'Desatascos', description: 'Fregaderos y bajantes.' },
  ],
  callToAction: 'Llámenos',
};

describe('buildSiteContentFromDraft', () => {
  it('amplía el texto del borrador y marca las rutas de ejemplo que existen', () => {
    const c = buildSiteContentFromDraft(
      COPY,
      {
        iconos_servicios: ['check', 'inventado'],
        cifras: [{ valor: 'Mismo día', etiqueta: 'en urgencias' }],
        precios: { nota: 'Orientativos', filas: [{ concepto: 'Visita', precio: 'Desde 40 €', detalle: '' }, { concepto: '', precio: 'x' }] },
        faq: [{ pregunta: '¿Cobran el desplazamiento?', respuesta: 'Va incluido.' }],
        ejemplos: ['cifras.0.valor', 'precios.filas.0.precio', 'precios.filas.5.precio', 'faq.0.respuesta'],
      },
      ['check', 'telefono'],
    );
    expect(c.datos.titular).toBe(COPY.headline);
    expect(c.datos.servicios.map((s) => s.icono)).toEqual(['check', '']);
    expect(c.datos.precios.filas).toHaveLength(1);
    expect(c.ejemplos).toEqual(expect.arrayContaining(['cifras.0.valor', 'precios.filas.0.precio', 'faq.0.respuesta']));
    expect(c.ejemplos).not.toContain('precios.filas.5.precio');
  });

  it('marca sola cualquier cifra que el modelo no haya marcado', () => {
    const c = buildSiteContentFromDraft(
      COPY,
      { garantias: [{ titulo: 'Garantía', texto: 'Seis meses por escrito.' }, { titulo: 'Rápidos', texto: 'Llegamos en 2 horas.' }], ejemplos: [] },
      [],
    );
    expect(c.ejemplos).toEqual(['garantias.1.texto']);
  });

  it('sin ampliación (falló la IA) sale con lo que había y sin ejemplos', () => {
    const c = buildSiteContentFromDraft(COPY, null, []);
    expect(c.datos.servicios).toHaveLength(2);
    expect(c.datos.cifras).toEqual([]);
    expect(c.ejemplos).toEqual([]);
  });

  it('el JSON con valla de markdown se interpreta; lo que no es JSON, no', () => {
    expect(parseExpansionResponse('```json\n{"cifras":[]}\n```')).toEqual({ cifras: [] });
    expect(parseExpansionResponse('lo siento')).toBeNull();
  });
});

describe('HTML de Google en el borrador', () => {
  it('cada reseña lleva su autor enlazado, cuándo y si está traducida', () => {
    const html = renderResenasHtml([
      { ref: 'r', rating: 5, text: 'Muy <bien>', translated: true, author: 'Víctor H.', authorUri: 'https://maps.google.com/u/1', relativeTime: 'Hace un año' },
    ]);
    expect(html).toContain('<figure class="resena">');
    expect(html).toContain('<a href="https://maps.google.com/u/1" rel="noopener nofollow" target="_blank">Víctor H.</a>');
    expect(html).toContain('hace un año · reseña de Google · traducida por Google');
    expect(html).toContain('Muy &lt;bien&gt;');
    expect(renderCitasHtml([{ title: 'T', quote: 'Q', author: 'A.' }])).toBe('<li class="cita"><h3>T</h3><p>«Q»</p><span class="cita-autor">A. · reseña de Google</span></li>');
  });
});

describe('borrador con plantilla', () => {
  const subject = {
    businessName: 'Fontanería Suárez',
    primaryType: 'plumber',
    city: 'Las Palmas',
    address: 'C. Camelia, 50',
    phone: '+34692271385',
    rating: 5,
    reviewCount: 17,
    hours: [{ days: 'Todos los días', hours: '8:00–20:00' }],
    googleMapsUri: 'https://maps.google.com/?cid=1',
    reviews: [{ ref: 'r', rating: 5, text: 'Muy bien', translated: false, author: 'V.', authorUri: null, relativeTime: null }],
    highlights: [{ title: 'Rápido', quote: 'Muy rápido', author: 'V.' }],
  };

  it('el contexto: teléfono legible, valoración solo si suma, citas desde dos, horario de Google', () => {
    const ctx = draftRenderContext({ subject, themeKey: 'trades-2', purchase: { kind: 'buy', href: '/empezar', priceLabel: '799 €' } });
    expect(ctx.negocio.telefono).toBe('692 27 13 85');
    expect(ctx.negocio.valoracion).toBe('5,0');
    expect(ctx.citasHtml).toBeNull();
    expect(ctx.resenasHtml).toContain('class="resena"');
    expect(ctx.horario).toEqual([{ dias: 'Todos los días', horas: '8:00–20:00' }]);
    // Un fontanero: la foto de su oficio (trade-photos.ts), no la genérica.
    expect(ctx.fotos.portada).toMatch(/^\/web-draft\/oficios\/fontaneria-[123]\.jpg$/);
    expect(ctx.footerHtml).toContain('La quiero · 799 €');
    expect(draftRenderContext({ subject: { ...subject, rating: 3.6 }, themeKey: 'trades-1' }).negocio.valoracion).toBeNull();
  });

  it('la banda enseña el enlace solo al operador, y sin oferta no hay sección de oferta', () => {
    expect(draftBannerHtml('X', null, 'https://p/borrador/t')).toContain('Enlace para mandarle');
    expect(draftBannerHtml('X', { kind: 'buy', href: '/e', priceLabel: '1 €' }, null)).toContain('href="#oferta"');
    expect(draftOfferHtml(null)).toBe('');
    expect(draftOfferHtml({ kind: 'call', href: 'https://cal' })).toContain('Reservar una llamada');
  });

  it('pinta con la plantilla; sin plantilla o con contenido roto, null (sale el de siempre)', async () => {
    const content = buildSiteContentFromDraft(COPY, { cifras: [{ valor: '15 años', etiqueta: 'de oficio' }], ejemplos: ['cifras.0.valor'] }, []);
    const prisma = {
      siteTemplate: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === 't1' ? SITE_TEMPLATE_BASE : null)) },
    } as unknown as PrismaClient;
    const html = await renderDesignedDraft(prisma, { templateId: 't1', content, subject, themeKey: 'trades-1', purchase: null });
    expect(html).toContain('Propuesta de Kairikos para <strong');
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<span class="dato-ejemplo">15 años</span>');
    expect(html).toContain('class="leyenda-ejemplos"');
    expect(await renderDesignedDraft(prisma, { templateId: 'otra', content, subject, themeKey: 'trades-1' })).toBeNull();
    expect(await renderDesignedDraft(prisma, { templateId: 't1', content: { version: 2 }, subject, themeKey: 'trades-1' })).toBeNull();
    expect(await renderDesignedDraft(prisma, { templateId: null, content, subject, themeKey: 'trades-1' })).toBeNull();
  });
});

describe('designForDraft', () => {
  const prisma = { siteTemplate: { findUnique: vi.fn(async () => SITE_TEMPLATE_BASE) } } as unknown as PrismaClient;
  beforeEach(() => {
    mocks.pick.mockReset();
    mocks.expand.mockReset();
  });

  it('sin plantilla aprobada para el sector no hace nada (ni gasta)', async () => {
    mocks.pick.mockResolvedValue(null);
    expect(await designForDraft(prisma, { copy: COPY, themeKey: 'beauty-3', businessName: 'X', primaryType: null, city: null })).toBeNull();
    expect(mocks.pick).toHaveBeenCalledWith(prisma, 'beauty');
    expect(mocks.expand).not.toHaveBeenCalled();
  });

  it('con plantilla, amplía con los iconos de su sprite; si la IA falla, contenido sin ampliar', async () => {
    mocks.pick.mockResolvedValue({ id: 't1' });
    mocks.expand.mockResolvedValue({ ok: false, error: 'x' });
    const r = await designForDraft(prisma, { copy: COPY, themeKey: 'trades-1', businessName: 'X', primaryType: 'plumber', city: 'Telde' });
    expect(r?.templateId).toBe('t1');
    expect(r?.content.datos.titular).toBe(COPY.headline);
    expect(mocks.expand.mock.calls[0][0]).toMatchObject({ kind: 'Fontanería', iconIds: templateIconIds(SITE_TEMPLATE_BASE.marco) });
    expect(r?.expanded).toBe(false);
  });

  it('una plantilla pedida (convertir) tiene que estar aprobada y ser de su sector', async () => {
    const findFirst = vi.fn(async () => null);
    const p = { siteTemplate: { findFirst, findUnique: vi.fn(async () => SITE_TEMPLATE_BASE) } } as unknown as PrismaClient;
    expect(await designForDraft(p, { copy: COPY, themeKey: 'trades-2', businessName: 'X', primaryType: null, city: null, templateId: 't9' })).toBeNull();
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't9', sector: 'trades', estado: 'aprobada' } }));
    expect(mocks.pick).not.toHaveBeenCalled();
    expect(mocks.expand).not.toHaveBeenCalled();
  });
});

describe('la plantilla base y las clases de Google', () => {
  it('sigue pasando el validador, que ahora exige estilo para citas y reseñas', () => {
    expect(validateSiteTemplate(SITE_TEMPLATE_BASE).problems).toEqual([]);
    const sinEstilo = { ...SITE_TEMPLATE_BASE, marco: SITE_TEMPLATE_BASE.marco.replace(/\.resena(?![\w-])/g, '.otra') };
    expect(validateSiteTemplate(sinEstilo).problems.join()).toMatch(/\.resena;/);
  });
});
