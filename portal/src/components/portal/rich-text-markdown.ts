// =============================================================================
// Un párrafo con formato editado sobre la vista, de vuelta a su texto
// (29/10/2026).
//
// Los textos largos («Quiénes somos», las respuestas, los bloques de texto) se
// guardan con el formato pequeño de lib/site-markdown.ts: párrafos, saltos,
// **negrita**, *cursiva*, listas «- » y «1. », títulos «## » y enlaces
// [texto](https://…, tel:, mailto:). En la vista del editor se editan ya
// pintados (contenteditable), y el navegador deja el HTML que le parece: <div>
// en vez de <p>, <b> en vez de <strong>, <span style> por todas partes, &nbsp;.
//
// Aquí se vuelve al texto con una regla estricta: de lo que hay solo
// sobreviven párrafos, saltos, negrita, cursiva, listas, títulos y enlaces con
// esquema permitido; todo lo demás se queda en su texto. Así lo que acaba en
// la web es siempre lo que el formato sabe pintar, y nada más, aunque se pegue
// algo raro (de todas formas, lo pegado entra como texto: SiteLivePreview).
//
// Puro y sin DOM: trabaja sobre una forma mínima de nodo, la que dan tanto el
// navegador como htmlparser2 en las pruebas.
// =============================================================================

export interface RichNode {
  nodeType: number; // 1 elemento, 3 texto
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<RichNode>;
  getAttribute?: (name: string) => string | null;
}

const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'PRE', 'TABLE', 'TR', 'FIGURE']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'K-HERRAMIENTAS', 'TEMPLATE']);
const SAFE_HREF = /^(https?:\/\/[^\s()<>]+|mailto:[^\s()<>]+|tel:\+?[0-9 ]{3,20})$/;

const children = (n: RichNode) => Array.from(n.childNodes);
const name = (n: RichNode) => n.nodeName.toUpperCase();

/** Envuelve en `mark` cada línea con texto, dejando fuera los espacios de los
 *  bordes: «** hola **» no lo reconoce el formato, «**hola**» sí. */
function wrap(inner: string, mark: string): string {
  return inner
    .split('\n')
    .map((line) => {
      const m = /^(\s*)(.*?)(\s*)$/.exec(line)!;
      return m[2] ? `${m[1]}${mark}${m[2].replace(/\*/g, '')}${mark}${m[3]}` : line;
    })
    .join('\n');
}

/** El texto de un trozo en línea, con sus marcas. */
function inline(nodes: RichNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.nodeType === 3) {
      out += (n.textContent ?? '').replace(/ /g, ' ').replace(/[\r\n\t]+/g, ' ');
      continue;
    }
    if (n.nodeType !== 1) continue;
    const tag = name(n);
    if (SKIP.has(tag)) continue;
    if (tag === 'BR') {
      out += '\n';
      continue;
    }
    const inner = inline(children(n));
    if (tag === 'STRONG' || tag === 'B') out += wrap(inner, '**');
    else if (tag === 'EM' || tag === 'I') out += wrap(inner, '*');
    else if (tag === 'A') {
      const href = (n.getAttribute?.('href') ?? '').trim();
      const label = inner.replace(/[[\]\n]/g, ' ').trim();
      out += SAFE_HREF.test(href) && label ? `[${label}](${href})` : inner;
    } else if (BLOCK.has(tag)) out += `\n${inner}\n`;
    else out += inner;
  }
  return out;
}

/** Limpia una línea: espacios repetidos fuera y sin espacios en los bordes. */
const tidy = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/ {2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

function blocks(nodes: RichNode[], out: string[]) {
  let buffer: RichNode[] = [];
  const flush = () => {
    const text = tidy(inline(buffer));
    if (text) out.push(text);
    buffer = [];
  };
  for (const n of nodes) {
    const tag = n.nodeType === 1 ? name(n) : '';
    if (n.nodeType !== 1 || !BLOCK.has(tag)) {
      if (!SKIP.has(tag)) buffer.push(n);
      continue;
    }
    flush();
    if (tag === 'UL' || tag === 'OL') {
      const items = children(n)
        .filter((c) => c.nodeType === 1 && name(c) === 'LI')
        .map((li) => tidy(inline(children(li))).replace(/\n/g, ' '))
        .filter(Boolean);
      if (items.length) out.push(items.map((t, i) => (tag === 'OL' ? `${i + 1}. ${t}` : `- ${t}`)).join('\n'));
    } else if (/^H[1-6]$/.test(tag)) {
      const text = tidy(inline(children(n))).replace(/\n/g, ' ');
      // El formato solo tiene dos niveles: «## » y «### ».
      if (text) out.push(`${['H1', 'H2'].includes(tag) ? '##' : '###'} ${text}`);
    } else if (children(n).some((c) => c.nodeType === 1 && BLOCK.has(name(c)))) {
      // Un <div> que envuelve párrafos (el de las marcas de ejemplo, o el que
      // mete el navegador): sus párrafos, cada uno el suyo.
      blocks(children(n), out);
    } else {
      const text = tidy(inline(children(n)));
      if (text) out.push(text);
    }
  }
  flush();
}

/** Un texto con formato tal y como lo devolvería richTextToMarkdown después de
 *  pintarlo: sin lo que el formato no distingue (espacios en los bordes de una
 *  línea, varias líneas en blanco seguidas). Para saber si lo que enseña la
 *  vista es el dato de ahora. */
export function normalMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .flatMap((b) => splitLists(b.split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim()).filter(Boolean)).map((g) => g.join('\n')))
    .filter(Boolean)
    .join('\n\n');
}

const UL_ITEM = /^[-*] +\S/;
const OL_ITEM = /^\d{1,2}[.)] +\S/;

/** 31/10/2026 — la misma regla que renderSiteMarkdown (site-markdown.ts,
 *  repetida aquí porque esto corre en el navegador): una lista pegada a una
 *  línea de texto es su propio bloque, y una numerada solo corta el párrafo
 *  si empieza por 1. Así «Te llevamos:» con la lista debajo, sin línea en
 *  blanco, no cuenta como cambiado al editarlo sobre la vista. */
function splitLists(lines: string[]): string[][] {
  const groups: string[][] = [];
  let kind = '';
  lines.forEach((l, i) => {
    const k = UL_ITEM.test(l) ? 'ul' : OL_ITEM.test(l) && (i === 0 || kind === 'ol' || /^1[.)]/.test(l)) ? 'ol' : 'p';
    if (k !== kind) groups.push([]);
    groups[groups.length - 1].push(l);
    kind = k;
  });
  return groups;
}

/** El texto con formato de lo que hay dentro de `root`. */
export function richTextToMarkdown(root: RichNode): string {
  const out: string[] = [];
  blocks(children(root), out);
  return out.join('\n\n');
}
