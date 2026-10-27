import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contrastHex,
  deriveAccentVariables,
  editorStyleOptions,
  parseTemplateStyle,
  resolveSiteStyle,
  rootColors,
  siteStyleCss,
  validateTemplateStyle,
  type SiteTemplateStyle,
} from '@/lib/site-style';
import { replaceGoogleFontFamilies } from '@/lib/site-fonts';
import { renderSiteFiles, SITE_TEMPLATE_PARTS, type SiteTemplatePart, type SiteTemplateSource } from '@/lib/site-template';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
import { parseSiteContent } from '@/lib/site-content';
import { checkPlan, CHECK_PAGES, CHECK_WIDTHS, STRESS_ACCENTS } from '@/lib/site-template-checks';
import { buildSiteContentFromDraft } from '@/lib/site-content-ai';

// El color y la letra de cada negocio (site-style.ts). Lo que importa: que el
// color que salga se lea SIEMPRE contra lo declarado, elija lo que elija el
// cliente, y que sin elección la web salga exactamente igual que antes.

const MARCO = `<html><head><link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700&family=Barlow&display=swap" rel="stylesheet"><style>:root{--noche:#0b1118;--blanco:#fff;--acento:#ffc21a;--acento-tinta:#7a5600;--display:"Barlow Condensed",sans-serif;--texto:"Barlow",sans-serif}</style></head><body></body></html>`;

const STYLE: SiteTemplateStyle = {
  acento: {
    variables: [
      { variable: '--acento', desde: 'color', contra: ['--noche'], minimo: 4.5 },
      { variable: '--acento-tinta', desde: 'tono', contra: ['--blanco'], minimo: 4.5 },
    ],
    muestras: [
      { nombre: 'Amarillo', color: '#ffc21a' },
      { nombre: 'Azul', color: '#4db5ff' },
    ],
  },
  tipografias: {
    titulares: '--display',
    texto: '--texto',
    parejas: [
      { id: 'obra', nombre: 'Obra', titulares: 'Barlow Condensed', texto: 'Barlow' },
      { id: 'rotulo', nombre: 'Rótulo', titulares: 'Oswald', texto: 'Inter' },
    ],
  },
};

describe('el color del negocio', () => {
  it('lee los colores del :root, también los de tres cifras', () => {
    expect(rootColors(MARCO).get('--blanco')).toBe('#ffffff');
    expect(rootColors(MARCO).get('--acento')).toBe('#ffc21a');
  });

  it('cualquier color que elija el cliente acaba leyéndose contra lo declarado', () => {
    const colores = ['#000000', '#ffffff', '#1d4ed8', '#e11d48', '#ffe600', '#808080', '#12332f', '#7fffd4', '#ff00ff'];
    for (const c of colores) {
      const v = deriveAccentVariables(MARCO, STYLE.acento!, c);
      expect(contrastHex(v['--acento'], '#0b1118'), `${c} → ${v['--acento']}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastHex(v['--acento-tinta'], '#ffffff'), `${c} → ${v['--acento-tinta']}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('un color que ya se lee se queda tal cual; uno oscuro sobre negro se aclara sin cambiar de familia', () => {
    expect(deriveAccentVariables(MARCO, STYLE.acento!, '#4db5ff')['--acento']).toBe('#4db5ff');
    const marino = deriveAccentVariables(MARCO, STYLE.acento!, '#1d2b6b')['--acento'];
    expect(marino).not.toBe('#1d2b6b');
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(marino.slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it('sin elección, o con el color de la plantilla, no cambia nada', () => {
    expect(resolveSiteStyle(MARCO, STYLE, undefined)).toBeNull();
    expect(resolveSiteStyle(MARCO, STYLE, { acento: '', tipografia: '' })).toBeNull();
    expect(resolveSiteStyle(MARCO, STYLE, { acento: '#FFC21A', tipografia: 'obra' })).toBeNull();
    expect(resolveSiteStyle(MARCO, null, { acento: '#4db5ff' })).toBeNull();
  });

  it('una pareja de otra plantilla se ignora; una de esta cambia las dos familias', () => {
    expect(resolveSiteStyle(MARCO, STYLE, { tipografia: 'clasica' })).toBeNull();
    const r = resolveSiteStyle(MARCO, STYLE, { tipografia: 'rotulo' });
    expect(r?.variables).toEqual({ '--display': '"Oswald",system-ui,sans-serif', '--texto': '"Inter",system-ui,sans-serif' });
    expect(r?.familias).toEqual({ 'Barlow Condensed': 'Oswald', Barlow: 'Inter' });
  });

  it('la hoja solo lleva variables, y nada que cierre el <style>', () => {
    expect(siteStyleCss({ '--acento': '#123456', '--x': 'red}</style><script>', 'color': 'red' })).toBe('<style id="estilo-negocio">:root{--acento:#123456}</style>');
  });
});

describe('la declaración de estilo de una plantilla', () => {
  it('una bien escrita pasa', () => {
    expect(validateTemplateStyle(STYLE, MARCO, ['Barlow Condensed', 'Barlow'])).toEqual([]);
    expect(validateTemplateStyle(null, MARCO, [])).toEqual([]);
  });

  it('dice qué está mal: variable que no existe, fondo que no existe, original que no se lee, letra fuera del catálogo', () => {
    const bad = structuredClone(STYLE);
    bad.acento!.variables.push({ variable: '--fantasma', desde: 'tono', contra: ['--nada'], minimo: 4.5 });
    bad.acento!.variables[1].contra = ['--noche'];
    bad.tipografias!.parejas[1].titulares = 'Comic Sans';
    const problems = validateTemplateStyle(bad, MARCO, ['Barlow Condensed', 'Barlow']).join('\n');
    expect(problems).toMatch(/--fantasma tiene que estar en el :root/);
    expect(problems).toMatch(/--acento-tinta \(#7a5600\) no llega a 4.5 contra #0b1118/);
    expect(problems).toMatch(/«Comic Sans» no está en el catálogo/);
  });

  it('la primera muestra y la primera pareja tienen que ser las de la plantilla', () => {
    const bad = structuredClone(STYLE);
    bad.acento!.muestras.reverse();
    bad.tipografias!.parejas.reverse();
    const problems = validateTemplateStyle(bad, MARCO, ['Barlow Condensed', 'Barlow']).join('\n');
    expect(problems).toMatch(/primera muestra tiene que ser el color de la plantilla \(#ffc21a\)/);
    expect(problems).toMatch(/primera pareja tiene que ser la que carga el marco/);
  });

  it('para el editor: muestras y parejas con las hojas de sus letras', () => {
    const o = editorStyleOptions(STYLE);
    expect(o?.muestras[1]).toEqual({ nombre: 'Azul', color: '#4db5ff' });
    expect(o?.parejas[1].hojas).toEqual(['/fuentes/oswald/fuentes.css', '/fuentes/inter/fuentes.css']);
    expect(editorStyleOptions(null)).toBeNull();
  });
});

describe('el motor con el estilo del negocio', () => {
  const dir = join(__dirname, '..', '..', 'plantillas', 'oficios-senal');
  const read = (p: string) => readFileSync(join(dir, `${p}.html`), 'utf8');
  const secciones: Partial<Record<SiteTemplatePart, string>> = {};
  for (const part of SITE_TEMPLATE_PARTS) secciones[part] = read(part);
  const meta = JSON.parse(readFileSync(join(dir, 'plantilla.json'), 'utf8')) as { estilo: unknown };
  const template: SiteTemplateSource = { marco: read('marco'), secciones, estilo: parseTemplateStyle(meta.estilo) };
  const home = (estilo?: { acento: string; tipografia: string }) =>
    renderSiteFiles(template, { ...SITE_CONTENT_SAMPLES.normal, ...(estilo ? { estilo } : {}) }, SAMPLE_RENDER_CONTEXT)
      .find((f) => f.path === 'index.html')!
      .content.toString('utf8');

  it('sin elección, la página es idéntica a la de la plantilla sin estilo', () => {
    expect(home()).toBe(renderSiteFiles({ ...template, estilo: null }, SITE_CONTENT_SAMPLES.normal, SAMPLE_RENDER_CONTEXT).find((f) => f.path === 'index.html')!.content.toString('utf8'));
    expect(home()).not.toContain('estilo-negocio');
  });

  it('con color, añade la hoja después de la de la plantilla', () => {
    const html = home({ acento: '#4db5ff', tipografia: '' });
    expect(html).toMatch(/<style id="estilo-negocio">:root\{--amarillo:#4db5ff;--amarillo-tinta:#[0-9a-f]{6};--amarillo-claro:#[0-9a-f]{6}\}<\/style>\n<\/head>/);
    expect(html.indexOf('estilo-negocio')).toBeGreaterThan(html.lastIndexOf('</style>', html.indexOf('estilo-negocio') - 1));
  });

  it('con otra letra, la web enlaza las familias nuevas y deja de enlazar las viejas', () => {
    const html = home({ acento: '', tipografia: 'rotulo' });
    expect(html).toContain('fuentes/oswald/fuentes.css');
    expect(html).toContain('fuentes/inter/fuentes.css');
    expect(html).not.toContain('fuentes/barlow-condensed/fuentes.css');
    expect(html).not.toContain('fonts.googleapis.com');
  });

  it('cambia familias en el enlace de Google Fonts antes de servirlas desde la web', () => {
    const html = replaceGoogleFontFamilies('<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700&amp;family=Barlow&amp;display=swap" rel="stylesheet">', { 'Barlow Condensed': 'Oswald', Barlow: 'Inter' });
    expect(html).toContain('family=Oswald&family=Inter');
  });
});

describe('el contenido guarda la elección', () => {
  it('normaliza el color y rechaza lo que no es #rrggbb', () => {
    const base = SITE_CONTENT_SAMPLES.normal;
    const ok = parseSiteContent({ ...base, estilo: { acento: ' #4DB5FF ', tipografia: 'rotulo' } });
    expect(ok.ok && ok.content.estilo).toEqual({ acento: '#4db5ff', tipografia: 'rotulo' });
    expect(parseSiteContent({ ...base, estilo: { acento: 'red', tipografia: '' } }).ok).toBe(false);
    expect(parseSiteContent({ ...base, estilo: { acento: '', tipografia: '<x>' } }).ok).toBe(false);
  });

  it('el borrador elige color y letra por nombre, solo de los ofrecidos', () => {
    const copy = { headline: 'Titular', subheadline: '', about: '', services: [{ name: 'Fugas', description: '' }], callToAction: '' };
    const estilo = { muestras: [{ nombre: 'Amarillo', color: '#ffc21a' }, { nombre: 'Azul', color: '#4DB5FF' }], parejas: [{ id: 'obra', nombre: 'Obra' }, { id: 'rotulo', nombre: 'Rótulo' }] };
    expect(buildSiteContentFromDraft(copy, { color: 'azul', letra: 'Rótulo' }, [], estilo).estilo).toEqual({ acento: '#4db5ff', tipografia: 'rotulo' });
    // La primera opción es la de la plantilla: se guarda vacía.
    expect(buildSiteContentFromDraft(copy, { color: 'Amarillo', letra: 'Obra' }, [], estilo).estilo).toEqual({ acento: '', tipografia: '' });
    expect(buildSiteContentFromDraft(copy, { color: 'Fucsia', letra: 'Comic' }, [], estilo).estilo).toBeUndefined();
    expect(buildSiteContentFromDraft(copy, { color: 'Azul' }, [], null).estilo).toBeUndefined();
  });
});

describe('qué mide el laboratorio', () => {
  it('sin estilo, las de siempre; con estilo, además cada color y cada pareja', () => {
    const base = CHECK_PAGES.length * CHECK_WIDTHS.length;
    expect(checkPlan(null)).toHaveLength(base);
    const plan = checkPlan(STYLE);
    const colores = new Set(plan.filter((p) => p.acento).map((p) => p.acento));
    expect([...colores].sort()).toEqual(['#4db5ff', ...STRESS_ACCENTS].sort());
    expect(plan.filter((p) => p.tipografia === 'rotulo')).toHaveLength(4);
    expect(plan.some((p) => p.tipografia === 'obra')).toBe(false);
    expect(plan).toHaveLength(base + colores.size * 3 + 4);
  });
});
