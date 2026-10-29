// El texto del formulario en la vista al momento (29/10/2026).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instantTextPatches, valueAt } from '@/components/portal/preview-patch';
import { SAMPLE_RENDER_CONTEXT, SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';
import { SITE_TEMPLATE_BASE } from '@/lib/site-template-base';
import { SITE_TEMPLATE_PARTS, renderSiteFiles, type SiteTemplateSource } from '@/lib/site-template';
import { parseTemplateStyle } from '@/lib/site-style';

const content = {
  datos: { titular: 'Hola', servicios: [{ nombre: 'Fugas' }, { nombre: 'Termos' }] },
  bloques: [{ id: 'historia', titulo: 'Nuestra historia' }],
};
const withData = (patch: (c: typeof content) => void) => {
  const c = structuredClone(content);
  patch(c);
  return c;
};

describe('valueAt', () => {
  it('datos, listas y bloques', () => {
    expect(valueAt(content, 'titular')).toBe('Hola');
    expect(valueAt(content, 'servicios.1.nombre')).toBe('Termos');
    expect(valueAt(content, 'bloques.historia.titulo')).toBe('Nuestra historia');
    expect(valueAt(content, 'bloques.otro.titulo')).toBeUndefined();
    expect(valueAt(content, 'servicios.9.nombre')).toBeUndefined();
  });
});

describe('instantTextPatches', () => {
  const shown = [
    { ruta: 'titular', text: 'Hola' },
    { ruta: 'servicios.0.nombre', text: 'Fugas' },
    { ruta: 'servicios.1.nombre', text: 'Termos' },
    { ruta: 'servicios.0.nombre', text: 'Fugas' },
  ];

  it('un dato cambiado: todas sus apariciones', () => {
    const next = withData((c) => (c.datos.servicios[0].nombre = 'Fugas y goteras'));
    expect(instantTextPatches(content, next, shown)).toEqual([
      { index: 1, text: 'Fugas y goteras' },
      { index: 3, text: 'Fugas y goteras' },
    ]);
  });

  it('varios datos a la vez (una lista reordenada): nada, espera al servidor', () => {
    const next = withData((c) => c.datos.servicios.reverse());
    expect(instantTextPatches(content, next, shown)).toEqual([]);
  });

  it('donde la vista no enseña el valor anterior, no se toca', () => {
    const next = withData((c) => (c.datos.titular = 'Hola, vecino'));
    expect(instantTextPatches(content, next, [{ ruta: 'titular', text: 'HOLA' }])).toEqual([]);
  });

  it('un campo vaciado espera al servidor (puede quitar el elemento entero)', () => {
    const next = withData((c) => (c.datos.titular = ''));
    expect(instantTextPatches(content, next, shown)).toEqual([]);
  });

  it('sin cambios, nada', () => {
    expect(instantTextPatches(content, structuredClone(content), shown)).toEqual([]);
  });
});

// La premisa: un <k-dato> de una línea enseña exactamente el valor de su dato.
// Si una plantilla la rompiera, el cambio al momento no se haría (no engaña),
// pero dejaría de servir: esta prueba lo avisa.
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
const decode = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

describe('lo que enseña la vista', () => {
  it.each(TEMPLATES)('%s: cada texto de una línea es el valor de su dato', (_, template) => {
    const sample = SITE_CONTENT_SAMPLES.normal;
    const html = renderSiteFiles(template, sample, { ...SAMPLE_RENDER_CONTEXT, edicion: true })
      .find((f) => f.path === 'index.html')!
      .content.toString('utf8');
    const datos = Array.from(html.matchAll(/<k-dato data-k-ruta="([^"]+)">([\s\S]*?)<\/k-dato>/g));
    expect(datos.length).toBeGreaterThan(10);
    const distintos = datos.filter(([, ruta, inner]) => decode(inner) !== String(valueAt(sample, ruta)));
    expect(distintos.map(([, ruta, inner]) => `${ruta}: ${inner}`)).toEqual([]);
  });
});
