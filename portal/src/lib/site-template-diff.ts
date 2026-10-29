// =============================================================================
// Qué cambia una corrección respecto a la plantilla aprobada (29/10/2026).
//
// Aprobar una corrección sustituye el diseño de TODAS las webs y borradores
// que usan la plantilla (site-template-jobs.ts). Antes de pulsar, el operador
// tiene que ver qué va a cambiar, no solo que pasó las comprobaciones: la
// corrección de Cercano era una línea de CSS, y eso es lo que tiene que leer.
//
// Diferencia por líneas (la de toda la vida: subsecuencia común más larga),
// pieza a pieza. Las plantillas escriben una regla de CSS por línea, así que
// la línea es la unidad que se entiende. Puro: se prueba sin base de datos.
// =============================================================================

export interface TemplateContent {
  marco: string;
  secciones: unknown;
  estilo: unknown;
}

export interface TemplateDiffPart {
  /** 'marco', el nombre de la sección ('portada', 'zona'…) o 'estilo'. */
  pieza: string;
  quitadas: string[];
  anadidas: string[];
  /** Líneas que no caben en la lista (se recorta a MAX_LINES por lado). */
  mas: number;
}

const MAX_LINES = 20;

function lines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd());
}

/** Las líneas quitadas y añadidas de `a` a `b`. */
export function diffLines(a: string, b: string): { quitadas: string[]; anadidas: string[] } {
  const x = lines(a);
  const y = lines(b);
  // Lo común al principio y al final no entra en la tabla: una corrección
  // suele tocar pocas líneas de un archivo de cientos.
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const xs = x.slice(start, endX);
  const ys = y.slice(start, endY);
  const n = xs.length;
  const m = ys.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = xs[i] === ys[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const quitadas: string[] = [];
  const anadidas: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (xs[i] === ys[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) quitadas.push(xs[i++]);
    else anadidas.push(ys[j++]);
  }
  while (i < n) quitadas.push(xs[i++]);
  while (j < m) anadidas.push(ys[j++]);
  return { quitadas: quitadas.filter((l) => l.trim()), anadidas: anadidas.filter((l) => l.trim()) };
}

function asParts(secciones: unknown): Record<string, string> {
  return secciones && typeof secciones === 'object' ? (secciones as Record<string, string>) : {};
}

/** Las piezas que cambian, en el orden marco → secciones → estilo. Vacío si
 *  la corrección no cambia nada. */
export function diffSiteTemplates(vigente: TemplateContent, correccion: TemplateContent): TemplateDiffPart[] {
  const a = asParts(vigente.secciones);
  const b = asParts(correccion.secciones);
  const piezas: [string, string, string][] = [
    ['marco', vigente.marco, correccion.marco],
    ...Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).map((k): [string, string, string] => [k, a[k] ?? '', b[k] ?? '']),
    ['estilo', JSON.stringify(vigente.estilo ?? null, null, 1), JSON.stringify(correccion.estilo ?? null, null, 1)],
  ];
  const out: TemplateDiffPart[] = [];
  for (const [pieza, antes, despues] of piezas) {
    if (antes === despues) continue;
    const { quitadas, anadidas } = diffLines(antes, despues);
    if (!quitadas.length && !anadidas.length) continue;
    const mas = Math.max(0, quitadas.length - MAX_LINES) + Math.max(0, anadidas.length - MAX_LINES);
    out.push({ pieza, quitadas: quitadas.slice(0, MAX_LINES), anadidas: anadidas.slice(0, MAX_LINES), mas });
  }
  return out;
}
