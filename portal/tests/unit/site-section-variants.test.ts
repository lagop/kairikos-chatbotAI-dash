import { describe, expect, it } from 'vitest';
import { parseSiteContent, type SiteContent } from '@/lib/site-content';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
import {
  SITE_SECTION_VARIANTS,
  SITE_VARIANT_PARTS,
  SITE_VARIANT_SETS,
  alternarVariantes,
  sectionVariant,
  withVariantSet,
} from '@/lib/site-section-variants';
import { VARIANT_SOURCES } from '@/lib/site-section-variants-markup';
import { checkPlan, variantSetLabel } from '@/lib/site-template-checks';
import { renderSitePage, type SiteTemplateSource } from '@/lib/site-template';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { validateSiteTemplate } from '@/lib/site-template-validate';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const normal = () => clone(SITE_CONTENT_SAMPLES.normal);

function withVariant(content: SiteContent, tipo: string, variante: string): SiteContent {
  for (const r of content.paginas[0].secciones) if (r.tipo === tipo) r.variante = variante;
  return content;
}

const render = (template: SiteTemplateSource, content: SiteContent) => renderSitePage(template, content, content.paginas[0], SAMPLE_RENDER_CONTEXT);

describe('variantes de sección: la lista', () => {
  it('toda variante tiene su pieza en el motor, y al revés', () => {
    for (const [tipo, vs] of Object.entries(SITE_SECTION_VARIANTS)) {
      expect(Object.keys(VARIANT_SOURCES[tipo as keyof typeof VARIANT_SOURCES] ?? {}).sort()).toEqual(vs!.map((v) => v.id).sort());
    }
    expect(Object.keys(VARIANT_SOURCES).sort()).toEqual(Object.keys(SITE_SECTION_VARIANTS).sort());
  });

  it('las 23 elegidas por Orlando el 30/10', () => {
    const muestras = [...Object.values(SITE_SECTION_VARIANTS).flatMap((vs) => vs!.map((v) => v.muestra))].sort();
    expect(muestras).toEqual(['F1', 'F2', 'L1', 'L2', 'L3', 'L4', 'O1', 'O2', 'O3', 'P1', 'P2', 'P3', 'P4', 'Q1', 'Q2', 'Q3', 'S1', 'S2', 'S3', 'S4'].sort());
  });

  it('una variante que no existe no es ninguna', () => {
    expect(sectionVariant('servicios', 'indice')?.muestra).toBe('S3');
    expect(sectionVariant('servicios', 'inventada')).toBeNull();
    expect(sectionVariant('zona', 'indice')).toBeNull();
    expect(sectionVariant('servicios', undefined)).toBeNull();
  });

  it('el contenido guarda la variante y acepta una que ya no exista', () => {
    const c = withVariant(normal(), 'servicios', 'ya-no-existe');
    const parsed = parseSiteContent(c);
    expect(parsed.ok && parsed.content.paginas[0].secciones.find((r) => r.tipo === 'servicios')?.variante).toBe('ya-no-existe');
    const bad = withVariant(normal(), 'servicios', '<script>');
    expect(parseSiteContent(bad).ok).toBe(false);
  });
});

describe('variantes de sección: el motor', () => {
  it('sin variante, la pieza de la plantilla, sin la hoja de las variantes', () => {
    const html = render(SITE_TEMPLATE_BASE, normal());
    expect(html).not.toContain('variantes-kairikos');
    expect(html).not.toContain('class="kv ');
  });

  it('con variante y sin pieza propia, la del motor con el título de la plantilla', () => {
    const html = render(SITE_TEMPLATE_BASE, withVariant(normal(), 'servicios', 'indice'));
    expect(html).toContain('class="kv kv-servicios kv-servicios--indice"');
    expect(html).toContain('<style id="variantes-kairikos">');
    expect(html.indexOf('variantes-kairikos')).toBeLessThan(html.indexOf('</head>'));
    // El título que marca la pieza propia de la base, no el genérico.
    const own = /<h2 data-k-titulo-seccion>([^<]*)<\/h2>/.exec(SITE_TEMPLATE_BASE.secciones.servicios ?? '')?.[1];
    expect(own).toBeTruthy();
    expect(html).toMatch(new RegExp(`kv-servicios--indice[\\s\\S]*<h2>${own}</h2>`));
    for (const s of normal().datos.servicios) expect(html).toContain(s.nombre);
  });

  it('el título propio del cliente gana también en una variante', () => {
    const c = withVariant(normal(), 'servicios', 'mosaico');
    c.datos.titulos.servicios = 'Lo que arreglamos';
    expect(render(SITE_TEMPLATE_BASE, c)).toMatch(/kv-servicios--mosaico[\s\S]*<h2>Lo que arreglamos<\/h2>/);
  });

  it('la pieza propia de la plantilla gana a la del motor', () => {
    const template: SiteTemplateSource = {
      ...SITE_TEMPLATE_BASE,
      secciones: { ...SITE_TEMPLATE_BASE.secciones, 'servicios@indice': '<section id="{{ancla}}"><h2 data-k-titulo-seccion>Propia</h2>{{#servicios}}<p class="propia">{{nombre}}</p>{{/servicios}}</section>' },
    };
    const html = render(template, withVariant(normal(), 'servicios', 'indice'));
    expect(html).toContain('class="propia"');
    expect(html).not.toContain('kv-servicios--indice');
  });

  it('una variante desconocida sale con la pieza de la plantilla', () => {
    const a = render(SITE_TEMPLATE_BASE, normal());
    const b = render(SITE_TEMPLATE_BASE, withVariant(normal(), 'servicios', 'ya-no-existe'));
    expect(b).toBe(a);
  });

  it('una sección vacía no se pinta aunque tenga variante', () => {
    const c = withVariant(normal(), 'proceso', 'linea');
    c.datos.proceso = [];
    expect(render(SITE_TEMPLATE_BASE, c)).not.toContain('kv-proceso');
  });

  it('marca los datos de ejemplo igual que una pieza de la plantilla', () => {
    const c = withVariant(normal(), 'precios', 'ventanitas');
    c.ejemplos = ['precios.filas.0.precio'];
    expect(render(SITE_TEMPLATE_BASE, c)).toMatch(/kv-fila-precio[\s\S]*?class="dato-ejemplo/);
  });

  it('cada juego de variantes pinta todas las secciones sin dejar huecos de Mustache', () => {
    for (let k = 0; k < SITE_VARIANT_SETS; k++) {
      for (const name of ['normal', 'exagerado', 'minimo'] as const) {
        const c = withVariantSet(clone(SITE_CONTENT_SAMPLES[name]), k);
        // Sin las hojas de estilo: «}}» es CSS normal (un @media).
        const html = render(SITE_TEMPLATE_BASE, c).replace(/<style[\s\S]*?<\/style>/g, '');
        expect(/.{0,60}(\{\{|\}\}).{0,40}/.exec(html)?.[0] ?? null).toBeNull();
      }
    }
  });

  it('el estilo de las pestañas (T1–T3) llega al bloque rico', () => {
    const c = withVariantSet(clone(SITE_CONTENT_SAMPLES.exagerado), 1);
    const page = c.paginas.find((p) => p.ruta === 'servicios')!;
    const html = renderSitePage(SITE_TEMPLATE_BASE, c, page, SAMPLE_RENDER_CONTEXT);
    expect(html).toContain('class="k-pestanas k-pestanas--pildora"');
  });

  it('la letra de los titulares de la plantilla, solo si la nombra', () => {
    const template: SiteTemplateSource = {
      ...SITE_TEMPLATE_BASE,
      estilo: { tipografias: { titulares: '--display', texto: '--texto', parejas: [] } } as unknown as SiteTemplateSource['estilo'],
    };
    const c = withVariant(normal(), 'servicios', 'zigzag');
    const hoja = (html: string) => /<style id="variantes-kairikos">[\s\S]*?<\/style>/.exec(html)?.[0] ?? '';
    expect(hoja(render(template, c))).toContain('font-family:var(--display)');
    expect(hoja(render(SITE_TEMPLATE_BASE, c))).not.toContain('font-family');
  });
});

describe('variantes de sección: el validador', () => {
  const base = () => clone(SITE_TEMPLATE_BASE);

  it('acepta la pieza propia de una variante', () => {
    const t = base();
    t.secciones['servicios@zigzag'] = '<section id="{{ancla}}"><h2 data-k-titulo-seccion>Servicios</h2>{{#servicios}}<h3>{{nombre}}</h3>{{/servicios}}</section>';
    expect(validateSiteTemplate(t).problems).toEqual(validateSiteTemplate(base()).problems);
  });

  it('pide la marca del título y rechaza variantes que no existen', () => {
    const t = base();
    t.secciones['servicios@zigzag'] = '<section id="{{ancla}}"><h2>Servicios</h2></section>';
    (t.secciones as Record<string, string>)['servicios@inventada'] = '<section></section>';
    const problems = validateSiteTemplate(t).problems.join('\n');
    expect(problems).toContain('«servicios@zigzag»: marca su título');
    expect(problems).toContain('sobra la sección «servicios@inventada»');
  });

  it('las piezas de variante son las de la lista', () => {
    expect(SITE_VARIANT_PARTS).toContain('portada@sangre');
    expect(SITE_VARIANT_PARTS).toContain('faq@dos-columnas');
  });
});

describe('P4: la portada con formulario', () => {
  const p4 = () => withVariant(normal(), 'portada', 'formulario');

  it('en el borrador es de muestra, como el de contacto, y no se envía', () => {
    const html = render(SITE_TEMPLATE_BASE, p4());
    expect(html).toContain('data-kairikos-form');
    expect(html.match(/type="submit" disabled/g)?.length).toBe(2);
    expect(html.match(/Formulario de muestra/g)?.length).toBe(2);
    expect(html).not.toContain('data-kairikos-form]');
  });

  it('publicada, el motor envía los dos formularios al mismo buzón', () => {
    const action = 'https://portal.kairikos.cloud/api/public/website-form/tok';
    const c = p4();
    const html = renderSitePage(SITE_TEMPLATE_BASE, c, c.paginas[0], { ...SAMPLE_RENDER_CONTEXT, borrador: false, formAction: action });
    expect(html).not.toContain('Formulario de muestra');
    expect(html).not.toMatch(/type="submit" disabled/);
    expect(html.split(JSON.stringify(action)).length - 1).toBe(1);
    expect(html).toContain('querySelectorAll("form[data-kairikos-form]")');
    expect(html).toContain('getElementById("kairikos-form")');
    for (const name of ['name', 'contact', 'message']) expect(html.match(new RegExp(`name="${name}"`, 'g'))?.length).toBe(2);
  });

  it('sin contacto en la página, el de la portada se envía igual', () => {
    const action = 'https://portal.kairikos.cloud/api/public/website-form/tok';
    const c = p4();
    c.paginas[0].secciones = c.paginas[0].secciones.filter((r) => r.tipo !== 'contacto');
    const html = renderSitePage(SITE_TEMPLATE_BASE, c, c.paginas[0], { ...SAMPLE_RENDER_CONTEXT, borrador: false, formAction: action });
    expect(html).not.toContain('id="kairikos-form"');
    expect(html).toContain('querySelectorAll("form[data-kairikos-form]")');
  });
});

describe('variantes de sección: el laboratorio', () => {
  it('mide cada juego, con su nombre en el resumen', () => {
    const runs = checkPlan(null).filter((p) => p.variantes !== undefined);
    expect(new Set(runs.map((r) => r.variantes)).size).toBe(SITE_VARIANT_SETS);
    expect(variantSetLabel(0)).toBe('P1, S1, Q1, L2, L1, L4, O1, F1');
    expect(variantSetLabel(3)).toContain('S4');
  });

  it('withVariantSet no toca el original', () => {
    const c = normal();
    const v = withVariantSet(c, 2);
    expect(c.paginas[0].secciones.some((r) => r.variante)).toBe(false);
    expect(v.paginas[0].secciones.find((r) => r.tipo === 'servicios')?.variante).toBe('indice');
  });
});

describe('alternarVariantes', () => {
  it('cambia solo la que repite la forma de la anterior', () => {
    // Servicios y garantías son rejilla en casi todas las plantillas.
    const out = alternarVariantes([{ tipo: 'portada' }, { tipo: 'servicios' }, { tipo: 'garantias' }, { tipo: 'faq' }]);
    expect(out[1].variante).toBeUndefined();
    expect(out[2].variante).toBeDefined();
    expect(sectionVariant('garantias', out[2].variante)?.forma).not.toBe('rejilla');
    // Y tampoco la de la siguiente (faq es lista).
    expect(sectionVariant('garantias', out[2].variante)?.forma).not.toBe('lista');
  });

  it('respeta lo elegido a mano si no choca, y las ocultas no cuentan', () => {
    const out = alternarVariantes([{ tipo: 'servicios', variante: 'mosaico' }, { tipo: 'proceso', oculta: true }, { tipo: 'garantias' }]);
    expect(out[0].variante).toBe('mosaico');
    expect(out[1].variante).toBeUndefined();
    expect(out[2].variante).toBeUndefined();
  });

  it('no toca los bloques ni el original', () => {
    const input = [{ tipo: 'servicios' }, { tipo: 'bloque', id: 'x' }, { tipo: 'bloque', id: 'y' }];
    const out = alternarVariantes(input);
    expect(out).toEqual(input);
    expect(out[0]).not.toBe(input[0]);
  });
});

describe('alternarVariantes al crear un borrador', () => {
  it('seVe: una sección sin contenido no separa a las que se tocan de verdad', () => {
    const refs = [{ tipo: 'servicios' }, { tipo: 'cifras' }, { tipo: 'garantias' }];
    // Contando las cifras (franja), garantías no repite la forma de servicios…
    expect(alternarVariantes(refs)[2].variante).toBeUndefined();
    // …pero si no salen, sí.
    expect(alternarVariantes(refs, { seVe: (r) => r.tipo !== 'cifras' })[2].variante).toBeDefined();
  });

  it('semilla: dos negocios no sacan por fuerza las mismas', () => {
    const refs = [{ tipo: 'portada' }, { tipo: 'servicios' }, { tipo: 'garantias' }];
    const picks = new Set([0, 1, 2, 3].map((semilla) => alternarVariantes(refs, { semilla })[2].variante));
    expect(picks).toEqual(new Set(['marcas', 'iconos']));
  });
});

describe('la versión propia de una variante', () => {
  it('lee las fotos extra del motor; una pieza normal no', () => {
    const t = clone(SITE_TEMPLATE_BASE) as SiteTemplateSource;
    t.secciones['portada@centrada'] = '<section id="{{ancla}}"><h1>{{titular}}</h1>{{#kv_fotos}}<img src="{{src}}" alt="">{{/kv_fotos}}</section>';
    expect(validateSiteTemplate(t).problems).toEqual([]);
    const html = render(t, withVariant(normal(), 'portada', 'centrada'));
    expect(html).toMatch(/<img src="[^"]+" alt="">/);
    t.secciones.portada = (t.secciones.portada as string).replace('</section>', '{{#kv_fotos}}{{src}}{{/kv_fotos}}</section>');
    expect(validateSiteTemplate(t).problems.join(' ')).toMatch(/kv_fotos/);
  });
});
