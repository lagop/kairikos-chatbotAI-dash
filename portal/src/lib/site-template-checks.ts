// =============================================================================
// Webs con IA, entrega 2 (27/10/2026) — lo que solo se ve PINTANDO una
// plantilla: desbordes, contraste, filas arrinconadas, menú partido, textos
// tapados y contenido invisible sin JavaScript.
//
// Corre en el NAVEGADOR DEL OPERADOR, no en el servidor: la página de
// plantillas (/admin/portal/plantillas) pinta cada plantilla en marcos de 360,
// 1100 y 1280 px con los tres contenidos de muestra y le pasa esto a cada uno.
// Así no hace falta meter Chromium en la VPS (cientos de MB en un disco que ya
// se llenó una vez), y es posible porque las plantillas solo se generan cuando
// las encarga el operador: por prospecto solo se escribe contenido, y las
// plantillas ya se han probado con el contenido exagerado.
//
// Sin dependencias ni 'server-only': lo importa un componente de cliente. Las
// comprobaciones son las de las pruebas del 26/10 (demos/*-check.js), con los
// falsos positivos que salieron ya corregidos, y los mensajes van pensados
// para la ronda de corrección: con el elemento, su contenedor y las reglas
// CSS que le aplican.
// =============================================================================

export const CHECK_WIDTHS = [360, 1100, 1280] as const;
export const CHECK_SAMPLES = ['normal', 'exagerado', 'minimo'] as const;
export type CheckSample = (typeof CHECK_SAMPLES)[number];

/** Qué se mide: la portada con los tres contenidos y, desde la entrega 5, la
 *  lista del blog y un artículo con el contenido exagerado (doce entradas,
 *  títulos de tres líneas, una URL larguísima en el texto) y la lista con
 *  el mínimo (una entrada sin extracto). Por tres anchos: 18 pasadas. */
export const CHECK_PAGES: readonly { contenido: CheckSample; pagina: string }[] = [
  ...CHECK_SAMPLES.map((contenido) => ({ contenido, pagina: '' })),
  { contenido: 'exagerado', pagina: 'servicios' },
  { contenido: 'exagerado', pagina: 'blog' },
  { contenido: 'exagerado', pagina: 'blog/entrada-1' },
  { contenido: 'minimo', pagina: 'blog' },
];

export interface CheckRun {
  ancho: number;
  contenido: CheckSample;
  /** '' = la portada. */
  pagina?: string;
  problemas: string[];
}

type Rgb = { r: number; g: number; b: number; a: number };

function parseColor(c: string): Rgb | null {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
}

function luminance({ r, g, b }: Rgb): number {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function describe(el: Element): string {
  const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className.trim().split(/\s+/).slice(0, 2).join('.') : '';
  return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls}` : '');
}

/** Las reglas CSS que aplican a un elemento, para que el modelo vea la causa
 *  y no solo el síntoma. */
function matchedRules(doc: Document, el: Element, max = 8): string[] {
  const out: string[] = [];
  const walk = (rules: CSSRuleList, media: string) => {
    for (const rule of Array.from(rules)) {
      if (out.length >= max) return;
      if ('cssRules' in rule && !(rule as CSSStyleRule).selectorText) {
        walk((rule as CSSGroupingRule).cssRules, (rule as CSSMediaRule).conditionText ?? media);
        continue;
      }
      const sel = (rule as CSSStyleRule).selectorText;
      if (!sel || sel.startsWith('*')) continue;
      try {
        if (el.matches(sel)) out.push((media ? `@media ${media} ` : '') + rule.cssText.slice(0, 220));
      } catch {
        // selectores con pseudo-elementos: matches() los rechaza
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      walk(sheet.cssRules, '');
    } catch {
      // hoja de otro origen (Google Fonts): no se puede leer
    }
  }
  return out;
}

function visible(win: Window, el: Element): boolean {
  const r = el.getBoundingClientRect();
  const s = win.getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
}

function ownText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent ?? '')
    .join(' ')
    .trim();
}

/**
 * Comprueba un documento ya pintado. `doc`/`win` son los del marco con la
 * plantilla; el resultado son frases para el modelo.
 */
export function runSiteChecks(doc: Document, win: Window): string[] {
  const problems: string[] = [];
  const W = doc.documentElement.clientWidth;

  // 1. Desbordes: los elementos más externos que se salen por los lados.
  if (doc.documentElement.scrollWidth > W + 1) {
    const out = Array.from(doc.body.querySelectorAll('*')).filter((e) => {
      const r = e.getBoundingClientRect();
      const s = win.getComputedStyle(e);
      return r.width > 0 && (r.right > W + 1 || (r.left < -1 && r.left > -1000)) && s.position !== 'fixed';
    });
    const outer = out.filter((e) => !out.some((o) => o !== e && o.contains(e))).slice(0, 4);
    for (const e of outer) {
      const r = e.getBoundingClientRect();
      const parent = e.parentElement;
      const pr = parent?.getBoundingClientRect();
      problems.push(
        `Desborde horizontal: la página mide ${doc.documentElement.scrollWidth} px y la ventana ${W}. ${describe(e)} va de ${Math.round(r.left)} a ${Math.round(r.right)} px` +
          (parent && pr ? ` y su contenedor ${describe(parent)} de ${Math.round(pr.left)} a ${Math.round(pr.right)} px` : '') +
          `. Reglas que le aplican: ${matchedRules(doc, e).join(' | ') || '(ninguna propia)'}`,
      );
    }
  }

  // 2. Contraste del texto contra el primer fondo opaco de debajo.
  const bgOf = (el: Element | null): Rgb | null => {
    for (let e = el; e; e = e.parentElement) {
      const s = win.getComputedStyle(e);
      if (s.backgroundImage !== 'none') return null; // degradado o foto: no se puede medir así
      const c = parseColor(s.backgroundColor);
      if (c && c.a > 0.9) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const contrast = new Set<string>();
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    const text = ownText(el);
    if (!text || el.closest('[aria-hidden="true"], svg, .leyenda-ejemplos, button[disabled]') || !visible(win, el)) continue;
    const s = win.getComputedStyle(el);
    if (Number(s.opacity) === 0) continue;
    const fg = parseColor(s.color);
    const bg = bgOf(el);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    const size = parseFloat(s.fontSize);
    const big = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    if (ratio < (big ? 3 : 4.5)) {
      contrast.add(`Contraste insuficiente (${ratio.toFixed(2)}, mínimo ${big ? 3 : 4.5}) en «${text.slice(0, 40)}» (${describe(el)}: color ${s.color} sobre ${`rgb(${bg.r}, ${bg.g}, ${bg.b})`}).`);
    }
  }
  problems.push(...Array.from(contrast).slice(0, 8));

  // 3. Reparto: la PRIMERA fila de una rejilla de tarjetas tiene que llenar el
  // ancho (la última puede ir incompleta: 6 en 4 columnas es 4 + 2), y las
  // tarjetas de una fila, medir lo mismo.
  for (const c of Array.from(doc.body.querySelectorAll('*'))) {
    if (!win.getComputedStyle(c).display.includes('grid') || c.closest('header, nav, form, footer, table')) continue;
    const kids = Array.from(c.children).filter((k) => visible(win, k) && win.getComputedStyle(k).position !== 'absolute');
    const cr = c.getBoundingClientRect();
    if (kids.length < 2 || cr.width < 500) continue;
    const first = kids.filter((k) => k.getBoundingClientRect().top < kids[0].getBoundingClientRect().bottom - 10);
    const left = Math.min(...first.map((k) => k.getBoundingClientRect().left));
    const right = Math.max(...first.map((k) => k.getBoundingClientRect().right));
    const fill = (right - left) / cr.width;
    const centered = Math.abs(left - cr.left - (cr.right - right)) < 24;
    if (fill < 0.8 && !centered) {
      problems.push(
        `Reparto: en ${describe(c)} la primera fila (${first.length} elementos) ocupa el ${Math.round(fill * 100)} % del ancho y queda arrimada a un lado. Reglas: ${matchedRules(doc, c).join(' | ')}`,
      );
    }
    const cards = first.filter((k) => {
      const s = win.getComputedStyle(k);
      return s.backgroundColor !== 'rgba(0, 0, 0, 0)' || s.borderTopWidth !== '0px' || s.boxShadow !== 'none';
    });
    if (cards.length >= 2) {
      const hs = cards.map((k) => k.getBoundingClientRect().height);
      if (Math.max(...hs) - Math.min(...hs) > 12) {
        problems.push(`Reparto: en ${describe(c)} las tarjetas de una misma fila miden de ${Math.round(Math.min(...hs))} a ${Math.round(Math.max(...hs))} px de alto; tienen que medir lo mismo (align-items: stretch).`);
      }
    }
  }

  // 4. Menú: ningún enlace partido en dos líneas.
  for (const a of Array.from(doc.querySelectorAll('header a, nav a'))) {
    if (!visible(win, a) || a.getBoundingClientRect().top > 200) continue;
    const tops = new Set(Array.from(a.getClientRects()).map((r) => Math.round(r.top)));
    const text = (a as HTMLElement).innerText?.trim() ?? '';
    if (tops.size > 1 && text) problems.push(`Menú: el enlace «${text}» se parte en dos líneas a ${W} px; los enlaces van con white-space:nowrap y, si no caben, el menú pasa a desplegable antes.`);
  }

  // 5. Texto tapado: el primer carácter de cada texto tiene que verse, ni bajo
  // otro elemento ni bajo un ::before/::after absoluto (los círculos numerados
  // de la prueba del 26/10 tapaban la primera letra de cada paso).
  const covered = new Set<string>();
  const pseudoBoxes: { owner: Element; box: DOMRect; which: string }[] = [];
  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    for (const which of ['::before', '::after']) {
      const ps = win.getComputedStyle(el, which);
      if (ps.content === 'none' || ps.position !== 'absolute') continue;
      // Detrás del contenido (z-index negativo): decoración, no tapa nada.
      if (parseInt(ps.zIndex, 10) < 0) continue;
      const w = parseFloat(ps.width);
      const h = parseFloat(ps.height);
      const l = parseFloat(ps.left);
      const t = parseFloat(ps.top);
      if (!(w > 0 && h > 0) || Number.isNaN(l) || Number.isNaN(t)) continue;
      const r = el.getBoundingClientRect();
      // Un fondo decorativo que cubre casi todo su contenedor (degradados de
      // portada) no es lo que tapa una letra; los círculos numerados sí.
      if (w * h > 0.4 * r.width * r.height) continue;
      pseudoBoxes.push({ owner: el, which, box: new DOMRect(r.left + l, r.top + t, w, h) });
    }
  }
  for (const el of Array.from(doc.body.querySelectorAll('h1, h2, h3, h4, p, li, a, span, strong, summary, dt, dd, label'))) {
    const node = Array.from(el.childNodes).find((n) => n.nodeType === 3 && n.textContent?.trim());
    if (!node || el.closest('[aria-hidden="true"]') || !visible(win, el)) continue;
    const i = (node.textContent ?? '').search(/\S/);
    const range = doc.createRange();
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const r = range.getBoundingClientRect();
    if (!r.width) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (const p of pseudoBoxes) {
      if (p.owner === el || !p.owner.contains(el)) continue;
      // Por área y no por el centro: el círculo de la prueba del 26/10 pisaba
      // el borde de la primera letra, no su centro, y se leía «os llama».
      const ox = Math.min(r.right, p.box.right) - Math.max(r.left, p.box.left);
      const oy = Math.min(r.bottom, p.box.bottom) - Math.max(r.top, p.box.top);
      if (ox > r.width * 0.25 && oy > r.height * 0.4) {
        covered.add(`Texto tapado: la primera letra de «${(node.textContent ?? '').trim().slice(0, 30)}» (${describe(el)}) queda debajo del ${p.which} de ${describe(p.owner)}. Reglas de ${describe(p.owner)}: ${matchedRules(doc, p.owner, 5).join(' | ')}`);
      }
    }
    if (cy >= 0 && cy <= win.innerHeight && cx >= 0 && cx <= W) {
      const top = doc.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el) && !top.closest('header')) {
        const s = win.getComputedStyle(top);
        // Lo fijo flota sobre el contenido a propósito (la leyenda de ejemplos,
        // un botón de llamar): al hacer scroll deja de tapar.
        const floating = (e: Element | null): boolean => {
          for (let x = e; x; x = x.parentElement) if (['fixed', 'sticky'].includes(win.getComputedStyle(x).position)) return true;
          return false;
        };
        if (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && Number(s.opacity) > 0.5 && !floating(top)) {
          covered.add(`Texto tapado: «${(node.textContent ?? '').trim().slice(0, 30)}» (${describe(el)}) queda debajo de ${describe(top)}.`);
        }
      }
    }
  }
  problems.push(...Array.from(covered).slice(0, 6));

  // 6. Sin JavaScript todo tiene que verse: en la comprobación se sirve la
  // plantilla SIN su <script>, así que un texto con opacidad 0 aquí es un
  // texto que no vería quien tenga el JavaScript bloqueado (ni Google).
  const hidden = Array.from(doc.body.querySelectorAll('*')).filter((e) => {
    // Lo que está dentro de un acordeón cerrado no se ve, pero no por la
    // animación: se abre al pulsar.
    if (!ownText(e) || e.closest('[hidden], [aria-hidden="true"]')) return false;
    const closed = e.closest('details:not([open])');
    if (closed && !e.closest('summary')) return false;
    const s = win.getComputedStyle(e);
    return Number(s.opacity) === 0 && s.display !== 'none';
  });
  if (hidden.length) {
    problems.push(
      `Contenido invisible sin JavaScript: ${hidden.slice(0, 3).map(describe).join(', ')} tiene opacidad 0. Lo que se oculta para animarlo solo se oculta si el JavaScript arrancó (html.js .clase).`,
    );
  }
  return problems;
}

/**
 * Junta los resultados de todas las pasadas (3 contenidos × 3 anchos) en una
 * lista para el modelo: el mismo fallo en varias pasadas sale una vez, con
 * dónde se vio.
 */
export function summarizeCheckRuns(runs: CheckRun[], max = 20): string[] {
  const seen = new Map<string, string[]>();
  for (const run of runs) {
    for (const p of run.problemas) {
      // Las medidas cambian con el ancho; se agrupa por la frase sin números.
      const key = p.replace(/\d+([.,]\d+)?/g, '#').slice(0, 160);
      const where = `${run.ancho} px, contenido ${run.contenido}${run.pagina ? `, página ${run.pagina}` : ''}`;
      if (!seen.has(key)) seen.set(key, [p, where]);
      else seen.get(key)?.push(where);
    }
  }
  return Array.from(seen.values())
    .slice(0, max)
    .map(([p, ...where]) => `${p} (visto a ${where.slice(0, 4).join('; ')}${where.length > 4 ? '…' : ''})`);
}
