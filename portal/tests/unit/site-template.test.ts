import { describe, expect, it } from 'vitest';
import { defaultHomePage, parseSiteContent, resolveContentPath, type SiteContent } from '@/lib/site-content';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
import { renderSiteMarkdown } from '@/lib/site-markdown';
import {
  MENU_MAX_LINKS,
  TemplateSyntaxError,
  buildMenu,
  pageFile,
  parseMustache,
  renderMustache,
  renderSiteFiles,
  renderSitePage,
  type SiteTemplateSource,
} from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { validateSiteTemplate } from '@/lib/site-template-validate';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const normal = () => clone(SITE_CONTENT_SAMPLES.normal);
const ctx = (over: Partial<typeof SAMPLE_RENDER_CONTEXT> = {}) => ({ ...SAMPLE_RENDER_CONTEXT, ...over });
const home = (c: SiteContent) => c.paginas[0];

describe('renderSiteMarkdown', () => {
  it('escapa todo antes de reconocer las marcas', () => {
    expect(renderSiteMarkdown('<script>alert(1)</script> y "comillas"')).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; y &quot;comillas&quot;</p>',
    );
  });

  it('párrafos, saltos de línea, negrita, cursiva y listas', () => {
    expect(renderSiteMarkdown('**Hola** y *adiós*\nsegunda línea\n\n- uno\n- dos\n\n1. a\n2. b')).toBe(
      '<p><strong>Hola</strong> y <em>adiós</em><br>segunda línea</p>\n<ul><li>uno</li><li>dos</li></ul>\n<ol><li>a</li><li>b</li></ol>',
    );
  });

  it('enlaces solo https, mailto y tel; javascript: se queda como texto', () => {
    expect(renderSiteMarkdown('[web](https://ejemplo.es) [correo](mailto:a@b.es) [llamar](tel:+34 600 000 000)')).toBe(
      '<p><a href="https://ejemplo.es" rel="noopener">web</a> <a href="mailto:a@b.es">correo</a> <a href="tel:+34600000000">llamar</a></p>',
    );
    expect(renderSiteMarkdown('[x](javascript:alert(1))')).not.toContain('<a');
  });

  it('unas comillas en la URL no pueden cerrar el atributo', () => {
    const html = renderSiteMarkdown('[x](https://a.es/" onmouseover="alert(1))');
    expect(html).not.toMatch(/<a[^>]*onmouseover/);
  });

  it('texto vacío → nada, para que la sección pueda no pintarse', () => {
    expect(renderSiteMarkdown('  \n ')).toBe('');
  });
});

describe('parseSiteContent', () => {
  it('las tres muestras son contenido válido', () => {
    for (const sample of Object.values(SITE_CONTENT_SAMPLES)) {
      const r = parseSiteContent(sample);
      expect(r.ok, JSON.stringify(!r.ok && r.issues)).toBe(true);
    }
  });

  it('rechaza rutas repetidas, falta de portada, bloques y ejemplos que no existen', () => {
    const c = normal();
    c.paginas.push({ ...defaultHomePage(), titulo: 'Otra' });
    c.paginas[0].secciones.push({ tipo: 'bloque', id: 'no-existe' });
    c.ejemplos.push('precios.filas.9.precio');
    const r = parseSiteContent(c);
    expect(r.ok).toBe(false);
    const messages = !r.ok ? r.issues.map((i) => i.message) : [];
    expect(messages).toEqual(expect.arrayContaining(['duplicate_page_path', 'unknown_block', 'unknown_example_path']));

    const sinPortada = normal();
    sinPortada.paginas[0].ruta = 'inicio';
    const r2 = parseSiteContent(sinPortada);
    expect(!r2.ok && r2.issues.map((i) => i.message)).toContain('missing_home_page');
  });

  it('una ruta de página no puede salirse del sitio', () => {
    const c = normal();
    c.paginas.push({ ...defaultHomePage('Malo'), ruta: '../fuera' });
    expect(parseSiteContent(c).ok).toBe(false);
  });

  it('las marcas de bloque van por id, no por posición', () => {
    const c = normal();
    expect(resolveContentPath(c, 'bloques.agosto.texto')).toBe('Cerrado del 10 al 20 de agosto.');
    c.bloques.reverse();
    expect(resolveContentPath(c, 'bloques.agosto.texto')).toBe('Cerrado del 10 al 20 de agosto.');
    expect(resolveContentPath(c, 'precios.filas.1.precio')).toBe('Desde 60 €');
    expect(resolveContentPath(c, 'precios.filas')).toBeUndefined();
  });
});

describe('motor de plantillas', () => {
  it('Mustache mal cerrado da un error que se puede devolver al modelo', () => {
    expect(() => parseMustache('{{#a}}x{{/b}}')).toThrow(TemplateSyntaxError);
    expect(() => parseMustache('{{#a}}x')).toThrow(/sin cerrar/);
  });

  it('listas, condicionales, .length e inversos', () => {
    const t = '{{#l.length}}<ul>{{#l}}<li>{{n}}</li>{{/l}}</ul>{{/l.length}}{{^l}}vacía{{/l}}';
    expect(renderMustache(t, { l: [{ n: 'a' }, { n: 'b' }] })).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMustache(t, { l: [] })).toBe('vacía');
  });

  it('escapa el texto del cliente', () => {
    expect(renderMustache('{{x}}', { x: '<img src=x onerror=alert(1)>' })).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('marca los datos de ejemplo por su ruta, en línea o en bloque', () => {
    const view = { precios: { filas: [{ precio: '40 €' }, { precio: '50 €' }] }, sobre_html: '<p>Hola</p>' };
    const out = renderMustache('{{#precios.filas}}[{{precio}}]{{/precios.filas}}{{{sobre_html}}}', view, ['precios.filas.1.precio', 'sobre']);
    expect(out).toBe('[40 €][<span class="dato-ejemplo">50 €</span>]<div class="dato-ejemplo dato-ejemplo-bloque"><p>Hola</p></div>');
  });

  it('no pinta las secciones ocultas ni las vacías, y el menú no las enlaza', () => {
    const c = normal();
    c.datos.faq = [];
    home(c).secciones = home(c).secciones.map((s) => (s.tipo === 'precios' ? { ...s, oculta: true } : s));
    const html = renderSitePage(SITE_TEMPLATE_BASE, c, home(c), ctx());
    expect(html).not.toContain('id="faq"');
    expect(html).not.toContain('id="precios"');
    expect(html).not.toContain('href="#precios"');
    expect(html).not.toContain('href="#faq"');
    expect(html).toContain('id="servicios"');
  });

  it('el menú lleva como mucho cinco enlaces y Contacto el último', () => {
    const c = normal();
    const rendered = ['servicios', 'precios', 'opiniones', 'faq', 'sobre', 'zona', 'proceso', 'contacto'].map((tipo) => ({
      kind: 'section' as const,
      tipo: tipo as never,
      anchor: tipo,
    }));
    const menu = buildMenu(c, home(c), rendered);
    expect(menu).toHaveLength(MENU_MAX_LINKS);
    expect(menu[menu.length - 1]).toEqual({ titulo: 'Contacto', href: '#contacto', actual: false });
  });

  it('los bloques libres se pintan donde los puso el cliente', () => {
    const c = normal();
    const html = renderSitePage(SITE_TEMPLATE_BASE, c, home(c), ctx());
    const agosto = html.indexOf('id="bloque-agosto"');
    const portada = html.indexOf('id="portada"');
    const historia = html.indexOf('id="bloque-historia"');
    expect(agosto).toBeGreaterThan(-1);
    expect(agosto).toBeLessThan(portada);
    expect(historia).toBeGreaterThan(html.indexOf('id="servicios"'));
    // El texto del aviso es un dato de ejemplo: va marcado, y sale la leyenda.
    expect(html).toContain('<div class="dato-ejemplo dato-ejemplo-bloque"><p>Cerrado del 10 al 20 de agosto.</p></div>');
    expect(html).toContain('class="leyenda-ejemplos"');
  });

  it('borrador: noindex, banda y formulario de muestra sin script de envío', () => {
    const c = normal();
    const html = renderSitePage(SITE_TEMPLATE_BASE, c, home(c), ctx({ borrador: true, bannerHtml: '<div class="banda-kairikos">Propuesta</div>' }));
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toMatch(/<body>\n<div class="banda-kairikos">Propuesta<\/div>/);
    expect(html).toContain('Formulario de muestra');
    expect(html).toMatch(/type="submit" disabled/);
    expect(html).not.toContain('/api/public/website-form/');
  });

  it('publicada: indexable, sin leyenda si no quedan ejemplos y con el envío del formulario', () => {
    const c = normal();
    c.ejemplos = [];
    const action = 'https://portal.kairikos.cloud/api/public/website-form/tok';
    const html = renderSitePage(SITE_TEMPLATE_BASE, c, home(c), ctx({ borrador: false, formAction: action }));
    expect(html).not.toContain('noindex');
    expect(html).not.toContain('leyenda-ejemplos"');
    expect(html).not.toContain('Formulario de muestra');
    expect(html).toContain(JSON.stringify(action));
    expect(html).toContain('Llámenos al <a href=\\"tel:+34600000000\\">600 00 00 00</a>');
  });

  it('varias páginas: un archivo por página, enlaces y fotos relativos a su profundidad', () => {
    const c = normal();
    c.paginas.push({ ruta: 'servicios/desatascos', titulo: 'Desatascos', metaTitulo: '', metaDescripcion: '', secciones: [{ tipo: 'servicios' }, { tipo: 'contacto' }] });
    c.blog.entradas = [];
    const files = renderSiteFiles(SITE_TEMPLATE_BASE, c, ctx());
    expect(files.map((f) => f.path)).toEqual(['index.html', 'servicios/desatascos/index.html']);
    const sub = files[1].content.toString('utf8');
    expect(pageFile('servicios/desatascos').base).toBe('../../');
    expect(sub).toContain('<a class="marca" href="../../">');
    expect(sub).toContain('<a href="../../servicios/desatascos/" aria-current="page">Desatascos</a>');
    // La portada no va en el menú: la marca de la cabecera ya lleva a ella.
    expect(sub).not.toContain('<a href="../../">Inicio</a>');
    expect(sub).toContain('<title>Desatascos · Fontanería Ejemplo</title>');
    const home = files[0].content.toString('utf8');
    expect(home).toContain('src="assets/portada.jpg"');
    expect(home).toContain('href="servicios/desatascos/"');
  });

  it('las tres muestras se pintan con la plantilla base sin dejar huecos sin rellenar', () => {
    for (const [name, sample] of Object.entries(SITE_CONTENT_SAMPLES)) {
      const html = renderSitePage(SITE_TEMPLATE_BASE, sample, sample.paginas[0], ctx());
      expect(html, name).not.toMatch(/\{\{/);
      expect(html, name).toContain(`<title>${sample.datos.titular}</title>`);
    }
  });
});

describe('validateSiteTemplate', () => {
  const base = (): SiteTemplateSource => clone(SITE_TEMPLATE_BASE);

  it('la plantilla base pasa sin problemas', () => {
    const r = validateSiteTemplate(base());
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('exige las variables con las que el motor pinta los bloques ricos, y dice para qué es cada una', () => {
    const t = base();
    t.marco = t.marco.replace(/--k-acento-texto:[^;]+;/, '').replace(/--k-superficie:[^;]+;/, '');
    const r = validateSiteTemplate(t);
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/Faltan: --k-acento-texto \(el acento como texto.*\), --k-superficie \(fondo de tarjeta\)\.$/);
    // --k-acento sigue declarada: que se llame igual que el principio de otra no confunde.
    expect(r.problems[0]).not.toMatch(/--k-acento \(/);
  });

  it('quita los atributos on* sin gastar una ronda de IA', () => {
    const t = base();
    t.secciones.contacto = (t.secciones.contacto as string).replace('method="post"', 'method="post" onsubmit="return false"');
    const r = validateSiteTemplate(t);
    expect(r.removedAttributes).toEqual(['onsubmit']);
    expect(r.template.secciones.contacto).not.toContain('onsubmit');
    expect(r.ok).toBe(true);
  });

  it('detecta piezas que faltan, huecos inventados y triple llave en texto del cliente', () => {
    const t = base();
    delete t.secciones.faq;
    t.secciones.servicios = (t.secciones.servicios as string).replace('{{nombre}}', '{{{nombre}}} {{precio_hora}}');
    const r = validateSiteTemplate(t);
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/falta la sección «faq»/);
    expect(r.problems.join('\n')).toMatch(/\{\{precio_hora\}\} no existe/);
    expect(r.problems.join('\n')).toMatch(/\{\{\{nombre\}\}\} va con triple llave/);
  });

  it('detecta cifras escritas a mano, recursos externos y JavaScript que hace peticiones', () => {
    const t = base();
    t.secciones.proceso = (t.secciones.proceso as string).replace('Del aviso', 'En 24 horas, del aviso');
    t.secciones.portada = (t.secciones.portada as string).replace('<h1>', '<img src="https://cdn.ejemplo.com/x.png" alt=""><h1>');
    t.marco = t.marco.replace('var root', 'fetch("/x"); var root');
    const text = validateSiteTemplate(t).problems.join('\n');
    expect(text).toMatch(/cifras escritas en la plantilla \(24\)/);
    expect(text).toMatch(/cdn\.ejemplo\.com/);
    expect(text).toMatch(/no puede hacer peticiones/i);
  });

  it('detecta la sección envuelta en su propia lista, que la repetía', () => {
    const t = base();
    t.secciones.servicios = `{{#servicios}}${t.secciones.servicios}{{/servicios}}`;
    expect(validateSiteTemplate(t).problems.join('\n')).toMatch(/envuelve otro \{\{#servicios\}\}/);
  });

  it('exige el formulario con los campos que espera el buzón', () => {
    const t = base();
    t.secciones.contacto = (t.secciones.contacto as string).replace('name="contact"', 'name="telefono"').replace('id="kairikos-form-note"', '');
    const text = validateSiteTemplate(t).problems.join('\n');
    expect(text).toMatch(/name="contact"/);
    expect(text).toMatch(/kairikos-form-note/);
  });

  it('exige el hueco de las secciones y el menú del motor en el marco', () => {
    const t = base();
    t.marco = t.marco.replace('{{{secciones}}}', '').replace(/\{\{#menu\}\}[\s\S]*?\{\{\/menu\}\}/, '<a href="#x">X</a>');
    const text = validateSiteTemplate(t).problems.join('\n');
    expect(text).toMatch(/\{\{\{secciones\}\}\} exactamente una vez \(lleva 0\)/);
    expect(text).toMatch(/el menú tiene que ser/);
  });
});
