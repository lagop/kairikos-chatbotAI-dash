// Un párrafo con formato editado sobre la vista, de vuelta a su texto (29/10/2026).
import { parseDocument } from 'htmlparser2';
import type { ChildNode, Document } from 'domhandler';
import { describe, expect, it } from 'vitest';
import { normalMarkdown, richTextToMarkdown, type RichNode } from '@/components/portal/rich-text-markdown';
import { renderSiteMarkdown } from '@/lib/site-markdown';
import { SITE_CONTENT_SAMPLES } from '@/lib/site-content-samples';

// htmlparser2 a la forma mínima de nodo que da el navegador.
function toRich(node: ChildNode | Document): RichNode {
  if (node.type === 'text') return { nodeType: 3, nodeName: '#text', textContent: node.data, childNodes: [] };
  const el = node as unknown as { name?: string; attribs?: Record<string, string>; children: ChildNode[] };
  return {
    nodeType: el.name ? 1 : 9,
    nodeName: el.name ?? '#document',
    textContent: null,
    childNodes: el.children.map(toRich),
    getAttribute: (n) => el.attribs?.[n] ?? null,
  };
}
const md = (html: string) => richTextToMarkdown(toRich(parseDocument(html, { decodeEntities: true })));

describe('de lo pintado al texto, y vuelta', () => {
  it.each([
    'Un párrafo sencillo.',
    'Dos párrafos.\n\nEl segundo.',
    'Una línea\ncon salto.',
    'Somos **puntuales** y *limpios*.',
    'Llámanos al [600 000 000](tel:600000000) o escribe a [hola](mailto:hola@example.com).',
    'Mira [nuestra web](https://example.com/a?b=1).',
    'Lo que traemos:\n\n- Detector de fugas\n- Cámara de inspección',
    '1. Llamas\n2. Vamos\n3. Arreglamos',
    '## Un título\n\nY su texto.',
  ])('%j sale igual', (texto) => {
    expect(md(renderSiteMarkdown(texto))).toBe(texto);
  });
});

describe('lo que deja el navegador al editar', () => {
  it('<div> y <b> de Chrome', () => {
    expect(md('<p>Hola</p><div>Segundo <b>párrafo</b></div><div><br></div>')).toBe('Hola\n\nSegundo **párrafo**');
  });

  it('espacios duros y repetidos, y negrita con espacios en el borde', () => {
    expect(md('<p>Hola&nbsp;&nbsp;mundo <strong> fuerte </strong>y ya</p>')).toBe('Hola mundo **fuerte** y ya');
  });

  it('negrita que cruza un salto: cada línea la suya', () => {
    expect(md('<p><b>uno<br>dos</b></p>')).toBe('**uno**\n**dos**');
  });

  it('el <div> de las marcas de ejemplo no cuenta', () => {
    expect(md('<div class="dato-ejemplo dato-ejemplo-bloque"><p>Uno</p><p>Dos</p></div>')).toBe('Uno\n\nDos');
  });
});

describe('lo que no puede colarse', () => {
  it('enlaces con otro esquema se quedan en su texto', () => {
    expect(md('<p><a href="javascript:alert(1)">pulsa</a> y <a href="data:text/html,x">esto</a></p>')).toBe('pulsa y esto');
  });

  it('estilos, clases, imágenes, scripts y tablas: solo su texto', () => {
    expect(md('<p><span style="color:red" class="x">rojo</span><img src="x.png" onerror="alert(1)"><script>alert(1)</script></p><table><tr><td>celda</td></tr></table>')).toBe('rojo\n\ncelda');
  });

  it('lo que sale vuelve a pintarse sin una sola etiqueta que no sea del formato', () => {
    const html = renderSiteMarkdown(md('<h1 onclick="x()">T</h1><p style="x"><u>sub</u><font color="red">f</font><a href="https://e.com" onclick="y">e</a></p>'));
    const tags = Array.from(html.matchAll(/<([a-z0-9]+)([^>]*)>/g), (m) => m[1] + m[2]);
    expect(tags).toEqual(['h2', 'p', 'a href="https://e.com" rel="noopener"']);
  });
});

// La vista solo deja editar un párrafo encima si enseña el dato de ahora
// (SiteLivePreview, showsCurrent): con un texto que no volviera igual, ese
// párrafo se editaría siempre desde el formulario.
describe('los textos largos de los ejemplos', () => {
  const textos = Object.values(SITE_CONTENT_SAMPLES).flatMap((c) => [c.datos.sobre, ...c.datos.faq.map((f) => f.respuesta), ...c.bloques.map((b) => b.texto)]).filter(Boolean);

  it.each(textos.map((t) => [t.slice(0, 40), t]))('%j: editar sin cambiar nada no cambia nada', (_, texto) => {
    expect(md(renderSiteMarkdown(texto))).toBe(normalMarkdown(texto));
  });
});
