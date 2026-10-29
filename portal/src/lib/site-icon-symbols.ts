// =============================================================================
// Los iconos de una plantilla, para enseñarlos en el editor (29/10/2026).
//
// Hasta hoy el cliente elegía el icono de un servicio en un desplegable con
// el nombre interno («check», «herramienta», «reloj»): no veía lo que elegía.
// Los dibujos están en el sprite de la plantilla (<symbol id="i-…">); aquí se
// sacan y se SANEAN antes de pasarlos a la página del portal, porque se
// pintan con dangerouslySetInnerHTML en el origen del portal. Una plantilla
// aprobada ya pasó el validador, pero el editor no tiene por qué fiarse: solo
// sobreviven las formas de SVG y sus atributos de dibujo.
//
// Puro: lo usa site-editor-data.ts (servidor) y se prueba sin red.
// =============================================================================

export interface IconSymbol {
  id: string;
  viewBox: string;
  /** El interior del <symbol>, ya saneado. */
  body: string;
}

const SHAPES = new Set(['g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
const ATTRS = new Set([
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'points', 'transform', 'opacity',
  'fill', 'fill-rule', 'fill-opacity', 'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-dasharray',
]);
// Un valor de atributo de dibujo no lleva nada que pueda cargar o ejecutar.
const SAFE_VALUE = /^[a-zA-Z0-9\s.,#%()+\-]*$/;

function sanitizeSymbolBody(body: string): string {
  let out = '';
  for (const m of body.matchAll(/<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>/g)) {
    const [, closing, rawName, rawAttrs, selfClosing] = m;
    const name = rawName.toLowerCase();
    if (!SHAPES.has(name)) continue;
    if (closing) {
      out += `</${name}>`;
      continue;
    }
    const attrs = Array.from(rawAttrs.matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g))
      .filter(([, k, v]) => ATTRS.has(k.toLowerCase()) && SAFE_VALUE.test(v) && !/url\s*\(/i.test(v))
      .map(([, k, v]) => ` ${k.toLowerCase()}="${v}"`)
      .join('');
    out += `<${name}${attrs}${selfClosing ? '/' : ''}>`;
  }
  return out;
}

/** Los iconos del sprite de una plantilla, en el orden en que aparecen. */
export function templateIconSymbols(marco: string): IconSymbol[] {
  const out: IconSymbol[] = [];
  const seen = new Set<string>();
  for (const m of marco.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/g)) {
    const id = m[1].match(/\sid="i-([a-z0-9-]+)"/)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const viewBox = m[1].match(/\sviewBox="([0-9.\s-]+)"/)?.[1] ?? '0 0 24 24';
    out.push({ id, viewBox, body: sanitizeSymbolBody(m[2]) });
  }
  return out;
}
