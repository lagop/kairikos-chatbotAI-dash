// La vista previa en vivo del editor (29/10/2026): el modo edición del motor y
// el cuerpo del POST de vista previa.
import { describe, expect, it } from 'vitest';
import { EDIT_MODE_HEAD, renderSiteFiles } from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
import { parsePreviewOverride } from '@/lib/website-preview';

const home = (edicion?: boolean) =>
  renderSiteFiles(SITE_TEMPLATE_BASE, SITE_CONTENT_SAMPLES.normal, { ...SAMPLE_RENDER_CONTEXT, edicion })
    .find((f) => f.path === 'index.html')!
    .content.toString('utf8');

describe('modo edición del motor', () => {
  it('solo en la vista previa del editor, al principio de <head>', () => {
    const html = home(true);
    expect(html.indexOf(EDIT_MODE_HEAD)).toBeGreaterThan(-1);
    expect(html.indexOf(EDIT_MODE_HEAD)).toBeLessThan(html.indexOf('<style'));
  });

  it('nunca en lo que se publica (la página idéntica se comprueba abajo, con las marcas)', () => {
    expect(home()).not.toContain('IntersectionObserver=IO');
    expect(home()).not.toContain('k-dato');
  });
});

describe('el cuerpo del POST de vista previa', () => {
  it('contenido obligatorio; teléfono y dirección opcionales y recortados', () => {
    expect(parsePreviewOverride(null)).toBeNull();
    expect(parsePreviewOverride({ phone: '600' })).toBeNull();
    expect(parsePreviewOverride({ content: 'x' })).toBeNull();
    expect(parsePreviewOverride({ content: { datos: {} }, phone: '  ', address: 'a'.repeat(500) })).toEqual({ content: { datos: {} }, phone: null, address: 'a'.repeat(300) });
  });
});

// ---- Edición directa: qué dato es cada texto (29/10/2026) ----------------------------

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEditMarks } from '@/lib/site-template';
import { SITE_TEMPLATE_PARTS, type SiteTemplateSource } from '@/lib/site-template';
import { parseTemplateStyle } from '@/lib/site-style';

function loadTemplate(dir: string): SiteTemplateSource {
  const read = (f: string) => (existsSync(join(dir, `${f}.html`)) ? readFileSync(join(dir, `${f}.html`), 'utf8').replace(/\r\n/g, '\n').trim() : '');
  const secciones: Record<string, string> = {};
  for (const part of SITE_TEMPLATE_PARTS) if (read(part)) secciones[part] = read(part);
  const meta = JSON.parse(readFileSync(join(dir, 'plantilla.json'), 'utf8'));
  return { marco: read('marco'), secciones, estilo: parseTemplateStyle(meta.estilo ?? null) };
}

const TEMPLATES: [string, SiteTemplateSource][] = [
  ['base', SITE_TEMPLATE_BASE],
  ...readdirSync(join(process.cwd(), 'plantillas')).map((d): [string, SiteTemplateSource] => [d, loadTemplate(join(process.cwd(), 'plantillas', d))]),
];

const pages = (template: SiteTemplateSource, sample: keyof typeof SITE_CONTENT_SAMPLES, edicion: boolean) =>
  renderSiteFiles(template, SITE_CONTENT_SAMPLES[sample], { ...SAMPLE_RENDER_CONTEXT, edicion })
    .filter((f) => f.path.endsWith('.html'))
    .map((f) => [f.path, f.content.toString('utf8')] as const);

const strip = (html: string) =>
  html
    .replace(`\n${EDIT_MODE_HEAD}`, '')
    .replace(/<k-dato data-k-ruta="[^"]*"(?: data-k-bloque style="display:block"| data-k-defecto)?>|<\/k-dato>/g, '')
    .replace(/ data-k-foto="[^"]*"/g, '');

describe('las marcas de edición', () => {
  it.each(TEMPLATES)('%s: quitando las marcas, cada página es idéntica a la que se publica', (_, template) => {
    for (const sample of ['normal', 'exagerado', 'minimo'] as const) {
      const publicada = new Map(pages(template, sample, false));
      for (const [path, html] of pages(template, sample, true)) {
        expect(html, `${sample} ${path}`).not.toMatch(/[\uE000-\uE004]/);
        expect(strip(html), `${sample} ${path}`).toBe(publicada.get(path));
      }
    }
  });

  it.each(TEMPLATES)('%s: los textos de la portada llevan su ruta, y nunca dentro de un atributo o de <title>', (_, template) => {
    const [, html] = pages(template, 'normal', true).find(([p]) => p === 'index.html')!;
    const rutas = new Set(Array.from(html.matchAll(/data-k-ruta="([^"]+)"/g), (m) => m[1]));
    const d = SITE_CONTENT_SAMPLES.normal.datos;
    expect(rutas).toContain('titular');
    d.servicios.forEach((_, i) => expect(rutas).toContain(`servicios.${i}.nombre`));
    expect(html).not.toMatch(/<title>[^<]*<k-dato/);
    expect(html).not.toMatch(/="[^"]*<k-dato/);
  });

  it('applyEditMarks: texto sí; atributo, comentario y script no', () => {
    const m = (ruta: string, v: string) => `${ruta}${v}`;
    const html = `<html><head><title>${m('titular', 'Hola')}</title></head><body><img alt="${m('servicios.0.nombre', 'Grifo')}"><!-- ${m('x', 'y')} --><h1>${m('titular', 'Hola')}</h1><script>var t = "${m('titular', 'Hola')}";</script><p>${''}sobre<b>Somos</b></p></body></html>`;
    expect(applyEditMarks(html)).toBe(
      '<html><head><title>Hola</title></head><body><img alt="Grifo"><!-- y --><h1><k-dato data-k-ruta="titular">Hola</k-dato></h1><script>var t = "Hola";</script><p><k-dato data-k-ruta="sobre" data-k-bloque style="display:block"><b>Somos</b></k-dato></p></body></html>',
    );
  });
});

// ---- Fotos pulsables: qué dato es cada foto (29/10/2026) -------------------------------

import { valueAt } from '@/components/portal/preview-patch';

describe('las fotos en modo edición', () => {
  const marked = (html: string) =>
    Array.from(html.matchAll(/<img\b[^>]*>/g), ([tag]) => ({ ruta: /data-k-foto="([^"]+)"/.exec(tag)?.[1] ?? '', src: /\ssrc="([^"]*)"/.exec(tag)?.[1] ?? '' })).filter((f) => f.ruta);

  it.each(TEMPLATES)('%s: la portada y la foto de un bloque, cada una con su dato aunque sean la misma imagen', (_, template) => {
    // En el ejemplo «exagerado» la foto de «historia» es la misma que la de la
    // portada: reconocerlas por la imagen las confundiría.
    const content = structuredClone(SITE_CONTENT_SAMPLES.exagerado);
    content.paginas[0].secciones.push({ tipo: 'bloque', id: 'historia' });
    const html = renderSiteFiles(template, content, { ...SAMPLE_RENDER_CONTEXT, edicion: true })
      .find((f) => f.path === 'index.html')!
      .content.toString('utf8');
    const portada = (SAMPLE_RENDER_CONTEXT.fotos.portada ?? '').replace(/^\//, '');
    expect(content.bloques.find((b) => b.id === 'historia')?.foto.endsWith(portada.split('/').pop()!)).toBe(true);
    const rutas = marked(html).map((m) => m.ruta);
    expect(rutas).toContain('imagenes.portada');
    expect(rutas).toContain('bloques.historia.foto');
  });

  it.each(TEMPLATES)('%s: cada foto marcada es la de su dato, también en los bloques ricos', (_, template) => {
    // Cada foto con un nombre propio, para comprobar que la ruta es la suya.
    const content = structuredClone(SITE_CONTENT_SAMPLES.exagerado);
    for (const b of content.bloques) {
      if (b.foto) b.foto = `assets/${b.id}-foto.jpg`;
      b.fotos.forEach((f, i) => f.foto && (f.foto = `assets/${b.id}-fotos-${i}.jpg`));
      b.productos.forEach((p, i) => p.foto && (p.foto = `assets/${b.id}-productos-${i}.jpg`));
      b.pestanas.forEach((p, i) => p.foto && (p.foto = `assets/${b.id}-pestanas-${i}.jpg`));
    }
    const fotos = renderSiteFiles(template, content, { ...SAMPLE_RENDER_CONTEXT, edicion: true })
      .filter((f) => f.path.endsWith('.html'))
      .flatMap((f) => marked(f.content.toString('utf8')));
    const deBloques = fotos.filter((f) => f.ruta.startsWith('bloques.'));
    for (const { ruta, src } of deBloques) expect(src.endsWith(String(valueAt(content, ruta))), ruta).toBe(true);
    for (const tipo of ['galeria', 'catalogo', 'pestanas', 'marcas']) {
      const ids = content.bloques.filter((b) => b.tipo === tipo).map((b) => b.id);
      expect(deBloques.some((f) => ids.includes(f.ruta.split('.')[1])), tipo).toBe(true);
    }
    expect(fotos.every((f) => f.ruta.startsWith('bloques.') || f.ruta === 'imagenes.portada' || f.ruta === 'imagenes.logo')).toBe(true);
  });
});

// ---- Los títulos de sección, del cliente (29/10/2026) ----------------------------------

import { sectionTitle } from '@/lib/site-template';
import { validateSiteTemplate } from '@/lib/site-template-validate';
import { SITE_TITLED_SECTIONS } from '@/lib/site-content';

describe('el título de una sección', () => {
  const html = '<section id="faq"><span class="rotulo">Preguntas</span><h2 class="t" data-k-titulo-seccion>Lo que más nos preguntan</h2><p>…</p></section>';

  it('sin título propio sale el de la plantilla, sin el atributo', () => {
    expect(sectionTitle(html, 'faq', { faq: '' }, false)).toBe(html.replace(' data-k-titulo-seccion', ''));
    expect(sectionTitle(html, 'faq', undefined, false)).toBe(html.replace(' data-k-titulo-seccion', ''));
  });

  it('con uno propio, el suyo, escapado; el resto de la sección igual', () => {
    expect(sectionTitle(html, 'faq', { faq: ' Dudas <b>& respuestas</b> ' }, false)).toBe(
      '<section id="faq"><span class="rotulo">Preguntas</span><h2 class="t">Dudas &lt;b&gt;&amp; respuestas&lt;/b&gt;</h2><p>…</p></section>',
    );
  });

  it('cambia todo lo que hay hasta SU cierre, aunque dentro se abra otra igual', () => {
    const anidado = '<div data-k-titulo-seccion="x"><div>Uno</div> dos</div><div>fuera</div>';
    expect(sectionTitle(anidado, 'zona', { zona: 'Nuevo' }, false)).toBe('<div>Nuevo</div><div>fuera</div>');
  });

  it('en el editor: un <k-dato> con su ruta; el de la plantilla, marcado como tal y sin marcas dentro', () => {
    expect(sectionTitle(html, 'faq', { faq: 'Dudas' }, true)).toContain('<h2 class="t"><k-dato data-k-ruta="titulos.faq">Dudas</k-dato></h2>');
    const sobre = `<h2 data-k-titulo-seccion>${String.fromCharCode(0xe000)}nombre${String.fromCharCode(0xe001)}Fontanería Suárez${String.fromCharCode(0xe002)}</h2>`;
    expect(sectionTitle(sobre, 'sobre', {}, true)).toBe('<h2><k-dato data-k-ruta="titulos.sobre" data-k-defecto>Fontanería Suárez</k-dato></h2>');
  });

  it('sin marca, o en una sección sin título propio, nada cambia salvo el atributo', () => {
    expect(sectionTitle('<h2>Fijo</h2>', 'faq', { faq: 'Otro' }, true)).toBe('<h2>Fijo</h2>');
    expect(sectionTitle('<h2 data-k-titulo-seccion>Cifras</h2>', 'cifras', { faq: 'Otro' }, true)).toBe('<h2>Cifras</h2>');
  });
});

describe('los títulos de sección en las plantillas', () => {
  const largo = SITE_CONTENT_SAMPLES.exagerado.datos.titulos.servicios;
  const ids = (html: string) => new Set(Array.from(html.matchAll(/\sid="([a-z]+)"/g), (m) => m[1]));
  const titleOf = (html: string, tipo: string) => html.match(new RegExp(`<k-dato data-k-ruta="titulos\.${tipo}"( data-k-defecto)?>([^<]*)</k-dato>`));

  it.each(TEMPLATES)('%s: cada sección con título lo marca, y en lo publicado no queda la marca', (_, template) => {
    expect(validateSiteTemplate(template).problems.filter((p) => p.includes('data-k-titulo-seccion'))).toEqual([]);
    for (const sample of ['normal', 'exagerado'] as const) {
      for (const [path, html] of pages(template, sample, false)) expect(html, `${sample} ${path}`).not.toContain('data-k-titulo-seccion');
    }
  });

  it.each(TEMPLATES)('%s: el título del cliente sale en su sección; sin él, el de la plantilla, editable igual', (_, template) => {
    let vistas = 0;
    for (const [path, html] of pages(template, 'exagerado', true)) {
      for (const tipo of SITE_TITLED_SECTIONS.filter((t) => ids(html).has(t))) {
        const m = titleOf(html, tipo);
        expect(m?.[2], `${path} ${tipo}`).toBe(largo);
        expect(m?.[1], `${path} ${tipo}`).toBeUndefined();
        vistas++;
      }
    }
    expect(vistas).toBeGreaterThan(0);
    for (const [path, html] of pages(template, 'normal', true)) {
      for (const tipo of SITE_TITLED_SECTIONS.filter((t) => ids(html).has(t))) {
        const m = titleOf(html, tipo);
        expect(m?.[1], `${path} ${tipo}`).toBe(' data-k-defecto');
        expect(m?.[2].trim(), `${path} ${tipo}`).not.toBe('');
      }
    }
  });
});

describe('el validador y los títulos', () => {
  it('pide la marca una vez en cada sección con título, y en ninguna otra', () => {
    const sin = { ...SITE_TEMPLATE_BASE, secciones: { ...SITE_TEMPLATE_BASE.secciones, faq: SITE_TEMPLATE_BASE.secciones.faq!.replace(' data-k-titulo-seccion', '') } };
    expect(validateSiteTemplate(sin).problems).toEqual([expect.stringMatching(/^la sección «faq»: marca su título con data-k-titulo-seccion exactamente una vez \(lleva 0\)/)]);
    const doble = { ...SITE_TEMPLATE_BASE, secciones: { ...SITE_TEMPLATE_BASE.secciones, zona: SITE_TEMPLATE_BASE.secciones.zona!.replace('<h2 data-k-titulo-seccion>', '<h2 data-k-titulo-seccion><span data-k-titulo-seccion>') } };
    expect(validateSiteTemplate(doble).problems).toEqual([expect.stringMatching(/«zona».*\(lleva 2\)/)]);
    const fuera = { ...SITE_TEMPLATE_BASE, secciones: { ...SITE_TEMPLATE_BASE.secciones, cifras: SITE_TEMPLATE_BASE.secciones.cifras!.replace('<section', '<section data-k-titulo-seccion') } };
    expect(validateSiteTemplate(fuera).problems).toEqual([expect.stringMatching(/^la sección «cifras»: quita data-k-titulo-seccion/)]);
  });
});
