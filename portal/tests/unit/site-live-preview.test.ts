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

const strip = (html: string) => html.replace(`\n${EDIT_MODE_HEAD}`, '').replace(/<k-dato data-k-ruta="[^"]*"(?: data-k-bloque style="display:block")?>|<\/k-dato>/g, '');

describe('las marcas de edición', () => {
  it.each(TEMPLATES)('%s: quitando las marcas, cada página es idéntica a la que se publica', (_, template) => {
    for (const sample of ['normal', 'exagerado', 'minimo'] as const) {
      const publicada = new Map(pages(template, sample, false));
      for (const [path, html] of pages(template, sample, true)) {
        expect(html, `${sample} ${path}`).not.toMatch(/[-]/);
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
