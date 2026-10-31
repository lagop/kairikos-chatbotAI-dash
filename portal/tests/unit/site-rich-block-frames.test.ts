import { describe, expect, it } from 'vitest';
import { renderSiteFiles, type SiteTemplateSource } from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { validateSiteTemplate } from '@/lib/site-template-validate';
import { BLOQUES_CSS, SITE_RICH_BLOCK_TYPES } from '@/lib/site-rich-blocks';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
import { withSectorExamples } from '@/lib/site-sector-blocks';

// 31/10/2026 — el marco propio de un bloque rico (bloque_galeria…): la
// plantilla pone el marco y el motor sigue pintando el cuerpo
// (richBlockFrameView, site-rich-blocks.ts).

const MARCO =
  '<section class="{{clase}} mi-galeria" id="{{ancla}}"><div class="mi-dentro">{{#ejemplo}}<div class="dato-ejemplo-bloque">{{/ejemplo}}' +
  '<header class="mi-cabeza"><p class="mi-rotulo">Galería</p><h2>{{titulo}}</h2></header>{{{texto_html}}}{{{cuerpo_html}}}' +
  '{{#ejemplo}}</div>{{/ejemplo}}</div></section>';

const conMarco = (marco = MARCO): SiteTemplateSource => ({ ...SITE_TEMPLATE_BASE, secciones: { ...SITE_TEMPLATE_BASE.secciones, bloque_galeria: marco } });

/** Una peluquería: trae una galería de ejemplo («trabajos») en la portada. */
function peluqueria(ejemplos = true) {
  const c = withSectorExamples({ ...structuredClone(SITE_CONTENT_SAMPLES.normal), ejemplos: [] }, { familia: 'beauty', businessName: 'Liso & Rizo', primaryType: 'hair_salon' });
  return ejemplos ? c : { ...c, ejemplos: [] };
}

const home = (template: SiteTemplateSource, content = peluqueria(), edicion = false) =>
  renderSiteFiles(template, content, { ...SAMPLE_RENDER_CONTEXT, edicion }).find((f) => f.path === 'index.html')!.content.toString('utf8');

const galeria = (html: string) => html.slice(html.indexOf('id="bloque-trabajos"') - 80, html.indexOf('</section>', html.indexOf('id="bloque-trabajos"')));

describe('marco propio de un bloque rico', () => {
  it('sin marco, el del motor, como siempre', () => {
    expect(galeria(home(SITE_TEMPLATE_BASE))).toContain('<section class="k-bloque k-galeria" id="bloque-trabajos"><div class="k-dentro">');
  });

  it('con marco: el de la plantilla, con el cuerpo del motor y sus ganchos', () => {
    const g = galeria(home(conMarco(), peluqueria(false)));
    expect(g).toContain('<section class="k-bloque k-galeria mi-galeria" id="bloque-trabajos"><div class="mi-dentro"><header class="mi-cabeza">');
    expect(g).toContain('<ul class="k-galeria-rejilla">');
    expect(g).toContain('data-k-galeria="trabajos"');
    expect(g).not.toContain('k-dentro');
    expect(g).not.toContain('dato-ejemplo');
  });

  it('de ejemplo: resaltado entero, y el título no se resalta dos veces', () => {
    const g = galeria(home(conMarco()));
    expect(g).toContain('<div class="mi-dentro"><div class="dato-ejemplo-bloque"><header class="mi-cabeza">');
    expect(g).not.toContain('<span class="dato-ejemplo">');
  });

  it('en el editor, las fotos se cambian pulsándolas y el título se edita sobre la vista', () => {
    const g = galeria(home(conMarco(), peluqueria(false), true));
    expect(g).toContain('data-k-foto="bloques.trabajos.fotos.0.foto"');
    expect(g).toMatch(/<h2><k-dato data-k-ruta="bloques\.trabajos\.titulo">/);
    // Lo que va dentro de un atributo no se marca.
    expect(g).toContain('class="k-bloque k-galeria mi-galeria" id="bloque-trabajos"');
  });
});

describe('el validador, con un marco propio', () => {
  const problems = (marco: string) => validateSiteTemplate(conMarco(marco)).problems.filter((p) => p.includes('bloque_galeria'));

  it('lo acepta si conserva ancla, clases, cuerpo y marca de ejemplo', () => {
    expect(validateSiteTemplate(SITE_TEMPLATE_BASE).ok).toBe(true);
    expect(problems(MARCO)).toEqual([]);
  });

  it('pide lo que no puede perder', () => {
    expect(problems(MARCO.replace('{{{cuerpo_html}}}', ''))).toEqual([expect.stringContaining('{{{cuerpo_html}}} exactamente una vez (lleva 0)')]);
    expect(problems(MARCO.replace('{{clase}} ', ''))).toEqual([expect.stringContaining('{{clase}}')]);
    expect(problems(MARCO.replace('id="{{ancla}}"', 'id="galeria"'))).toEqual([expect.stringContaining('id="{{ancla}}"')]);
    expect(problems(MARCO.replace('{{#ejemplo}}</div>{{/ejemplo}}', '</div>'))).toEqual([expect.stringContaining('dato-ejemplo-bloque')]);
    // El cuerpo fuera de la marca de ejemplo: las fotos de banco saldrían sin resaltar.
    expect(problems(MARCO.replace('{{{cuerpo_html}}}{{#ejemplo}}</div>{{/ejemplo}}', '{{#ejemplo}}</div>{{/ejemplo}}{{{cuerpo_html}}}'))).toEqual([expect.stringContaining('dato-ejemplo-bloque')]);
  });

  it('sus campos solo existen en esas piezas', () => {
    const t = { ...SITE_TEMPLATE_BASE, secciones: { ...SITE_TEMPLATE_BASE.secciones, bloque_lista: `${SITE_TEMPLATE_BASE.secciones.bloque_lista}{{{cuerpo_html}}}` } };
    expect(validateSiteTemplate(t).problems).toEqual([expect.stringContaining('{{cuerpo_html}} no existe')]);
  });
});

describe('las clases de la <section> de un bloque', () => {
  // 31/10/2026 — la <section> lleva k-comparativa, k-trayectoria y k-marcas,
  // las mismas clases que la tabla, la lista y la cinta de dentro: la sección
  // heredaba el sangrado, el ancho máximo y la línea de la trayectoria, y el
  // fondo y las esquinas de la tabla. Lo vio la bifurcación de Pizarra.
  it('ninguna regla del motor para esas clases alcanza la <section>', () => {
    for (const tipo of SITE_RICH_BLOCK_TYPES) {
      const cls = `k-${tipo.replace('_', '-')}`;
      const suelta = new RegExp(`(^|[},\n])\s*\.${cls}(?=[{,:]|::)(?!:where)`, 'm');
      expect(BLOQUES_CSS, cls).not.toMatch(suelta);
    }
  });
});

describe('los filtros del catálogo sin JavaScript', () => {
  // 31/10/2026 — salen con hidden y el script los enseña; el display:flex de
  // .k-filtros le ganaba al atributo y sin JS se veían botones que no hacían
  // nada (Señal, Atelier, Sello, Bloque). Lo vio la bifurcación de Sello.
  it('el motor respeta hidden aunque la plantilla los reestile', () => {
    expect(BLOQUES_CSS).toContain('.k-filtros[hidden]{display:none!important}');
  });
});
