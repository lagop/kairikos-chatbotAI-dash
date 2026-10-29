'use client';

import { useEffect, useRef, useState } from 'react';

// =============================================================================
// La vista previa EN VIVO del editor de la web (29/10/2026).
//
// Al lado del formulario, la web tal y como va quedando, con lo que hay
// escrito aunque no esté guardado: el editor manda el contenido a la vista
// previa por POST (website-preview.ts, override) y la página que vuelve se
// escribe en este marco. Se repinta medio segundo después de dejar de
// escribir, no con cada tecla.
//
// Por qué escribir el documento (document.write) y no cambiar el src: así la
// vista conserva el scroll entre un cambio y otro (se guarda y se repone), y
// el marco es del mismo origen que el portal, que es lo que permite editar
// sobre él sin meter scripts en la web. La web ya se servía desde este mismo
// origen en la vista previa de siempre: no se abre nada que no estuviera.
//
// Dentro de la vista nada navega: un enlace del menú a una sección baja hasta
// ella; los demás no hacen nada (estás editando, no visitando). Los
// formularios no se envían.
//
// «Ordenador» pinta la web a 1280 px y la reduce para que quepa: a 800 px de
// verdad se vería como en una tableta y engañaría. «Móvil», a 390 px.
//
// EDICIÓN DIRECTA. En modo edición el motor envuelve cada texto del contenido
// en <k-dato data-k-ruta="…"> (site-template.ts, applyEditMarks). Aquí:
// - Pulsar un texto lo edita ahí mismo, con la letra de la web
//   (contenteditable «plaintext-only»: lo que se pega llega sin formato).
//   Intro o pulsar fuera lo deja; Esc lo deshace. El límite de cada campo es
//   el del formulario. Si el mismo texto sale en varios sitios (una cinta de
//   servicios que se repite), cambian todos a la vez.
// - Mientras se escribe encima, la vista NO se repinta: perdería el cursor.
//   Lo que llegue entretanto se pinta al terminar.
// - Un párrafo con formato (negritas, listas: data-k-bloque) o cualquier otra
//   cosa de una sección abre su campo en el formulario.
// - Los elementos de una lista (servicios, precios, preguntas…) enseñan al
//   pasar el ratón ↑ ↓ ✕ + para ordenarlos, quitarlos o añadir otro.
// Nada de esto toca el HTML de la plantilla: los <k-dato> y la barra de la
// lista son nuestros, y solo existen en esta vista.
// =============================================================================

export type PreviewDevice = 'ordenador' | 'movil';

export interface PreviewPick {
  /** El dato pulsado, o null si se pulsó otra cosa de una sección. */
  ruta: string | null;
  /** El id de la sección o bloque donde se pulsó. */
  seccion: string | null;
  /** Si se está editando sobre la vista (si no, hay que ir al formulario). */
  inline: boolean;
}

export type ListAction = 'subir' | 'bajar' | 'quitar' | 'anadir';

const DESKTOP_WIDTH = 1280;
const MOBILE_WIDTH = 390;
const DEBOUNCE_MS = 450;

const PREVIEW_CSS = [
  // La sección que se está editando en el formulario.
  '.k-editor-activo{outline:3px solid rgba(124,58,237,.85)!important;outline-offset:-3px}',
  // Lo que se puede editar, al pasar por encima; y lo que se está editando.
  'k-dato[data-k-ruta]{cursor:text;border-radius:3px}',
  'k-dato[data-k-ruta]:hover{outline:2px dashed rgba(124,58,237,.75);outline-offset:3px}',
  'k-dato[data-k-bloque]{cursor:pointer}',
  'k-dato[contenteditable]{outline:2px solid #7c3aed!important;outline-offset:3px;background:rgba(124,58,237,.07)}',
  '[data-k-lista].k-lista-encima{outline:1px dashed rgba(124,58,237,.5);outline-offset:6px}',
].join('');

/** La lista y la posición de una ruta de lista ('servicios.2.nombre' →
 *  ['servicios', 2]; 'bloques.x.items.0.texto' → ['bloques.x.items', 0]). */
function listOf(ruta: string): [string, number] | null {
  const m = /^(.+)\.(\d+)\.[a-zA-Z_]+$/.exec(ruta);
  return m ? [m[1], Number(m[2])] : null;
}

export function SiteLivePreview({
  apiBase,
  path,
  body,
  activeAnchor,
  device,
  sectionIds = [],
  onPick,
  onInlineChange,
  maxFor,
  onListAction,
}: {
  /** Igual que el editor: la del cliente o la del operador. */
  apiBase: string;
  /** La página que se edita ('' la portada, '/servicios'…). */
  path: string;
  /** El JSON con lo que hay en el formulario ({ content, phone, address }). */
  body: string;
  /** El id de la sección o bloque que se está editando ('servicios',
   *  'bloque-historia'): la vista va hasta él (si no se ve ya) y lo marca. */
  activeAnchor: string | null;
  device: PreviewDevice;
  /** Los ids de las secciones de esta página, para saber dónde se pulsó. */
  sectionIds?: string[];
  onPick?: (pick: PreviewPick) => void;
  onInlineChange?: (ruta: string, value: string) => void;
  maxFor?: (ruta: string) => number;
  /** Qué listas se pueden ordenar desde la vista (y cuántos elementos caben). */
  onListAction?: (list: string, index: number, action: ListAction) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(activeAnchor);
  const firstRef = useRef(true);
  const inlineRef = useRef<{ el: HTMLElement; ruta: string; original: string; last: string } | null>(null);
  const pendingRef = useRef<string | null>(null);
  // Los oyentes se ponen al pintar: leen siempre lo último que llegó.
  const cb = useRef({ onPick, onInlineChange, maxFor, onListAction, sectionIds });
  cb.current = { onPick, onInlineChange, maxFor, onListAction, sectionIds };
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'error'>('cargando');
  const [size, setSize] = useState({ width: 0, height: 0 });

  // El tamaño disponible, para encajar la web de ordenador reducida.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Marca la sección que se está editando y, si se pide y no se ve ya, va
   *  hasta ella (si se pulsó dentro de ella, no se mueve nada). */
  function mark(scroll: boolean) {
    const doc = frameRef.current?.contentDocument;
    const win = frameRef.current?.contentWindow;
    if (!doc || !win) return;
    doc.querySelectorAll('.k-editor-activo').forEach((el) => el.classList.remove('k-editor-activo'));
    const id = activeRef.current;
    const el = id ? doc.getElementById(id) : null;
    if (!el) return;
    el.classList.add('k-editor-activo');
    const r = el.getBoundingClientRect();
    const visible = r.bottom > 0 && r.top < win.innerHeight;
    if (scroll && !visible) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function finishInline() {
    const cur = inlineRef.current;
    if (!cur) return;
    inlineRef.current = null;
    cur.el.removeAttribute('contenteditable');
    if (pendingRef.current) {
      const html = pendingRef.current;
      pendingRef.current = null;
      paint(html);
    }
  }

  function startInline(el: HTMLElement, e: MouseEvent) {
    if (inlineRef.current?.el === el) return;
    finishInline();
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    const ruta = el.getAttribute('data-k-ruta') ?? '';
    const original = el.textContent ?? '';
    try {
      el.contentEditable = 'plaintext-only';
    } catch {
      /* lo de abajo */
    }
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
    el.spellcheck = true;
    inlineRef.current = { el, ruta, original, last: original };
    el.focus();
    // El cursor donde se pulsó, no al principio.
    const d = doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null; caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
    let range: Range | null = d.caretRangeFromPoint?.(e.clientX, e.clientY) ?? null;
    if (!range && d.caretPositionFromPoint) {
      const pos = d.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) {
        range = doc.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (range && el.contains(range.startContainer)) {
      const sel = win?.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }

    const sameRuta = () => Array.from(doc.querySelectorAll<HTMLElement>('k-dato[data-k-ruta]')).filter((x) => x !== el && x.getAttribute('data-k-ruta') === ruta);
    const caretToEnd = () => {
      const r = doc.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const sel = win?.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    };
    const set = (value: string) => {
      sameRuta().forEach((x) => (x.textContent = value));
      cb.current.onInlineChange?.(ruta, value);
    };
    const onInput = () => {
      const cur = inlineRef.current;
      if (!cur || cur.el !== el) return;
      let value = el.textContent ?? '';
      // Un campo de una línea: los saltos (o lo pegado en varias) son espacios.
      if (/\n/.test(value)) {
        value = value.replace(/\s*\n\s*/g, ' ');
        el.textContent = value;
        caretToEnd();
      }
      const max = cb.current.maxFor?.(ruta) ?? 300;
      if (value.length > max) {
        el.textContent = cur.last;
        caretToEnd();
        return;
      }
      cur.last = value;
      set(value);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        el.blur();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        el.textContent = original;
        set(original);
        el.blur();
      }
    };
    // Sin «plaintext-only» (navegadores antiguos), lo pegado llega sin formato igual.
    const onPaste = (ev: ClipboardEvent) => {
      if (el.contentEditable === 'plaintext-only') return;
      ev.preventDefault();
      const text = (ev.clipboardData?.getData('text/plain') ?? '').replace(/\s+/g, ' ');
      doc.execCommand('insertText', false, text);
    };
    const onBlur = () => {
      el.removeEventListener('input', onInput);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('paste', onPaste);
      el.removeEventListener('blur', onBlur);
      finishInline();
    };
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
    el.addEventListener('paste', onPaste);
    el.addEventListener('blur', onBlur);
  }

  /** Los elementos de las listas, para la barra de ↑ ↓ ✕ +. Un elemento es lo
   *  más pequeño que contiene sus textos sin contener los de otro; si sale en
   *  varios sitios (la cinta de servicios), cada aparición por su cuenta. */
  function markListItems(doc: Document) {
    const groups = new Map<string, HTMLElement[]>();
    doc.querySelectorAll<HTMLElement>('k-dato[data-k-ruta]').forEach((el) => {
      const l = listOf(el.getAttribute('data-k-ruta') ?? '');
      if (!l) return;
      const key = `${l[0]}|${l[1]}`;
      groups.set(key, [...(groups.get(key) ?? []), el]);
    });
    const indexOf = (el: Element) => listOf(el.getAttribute('data-k-ruta') ?? '');
    for (const [key, els] of groups) {
      const [list, index] = [key.slice(0, key.lastIndexOf('|')), Number(key.slice(key.lastIndexOf('|') + 1))];
      const clean = (item: Element | null): boolean =>
        Boolean(item) &&
        item !== doc.body &&
        !Array.from(item!.querySelectorAll('k-dato[data-k-ruta]')).some((x) => {
          const l = indexOf(x);
          return Boolean(l && l[0] === list && l[1] !== index);
        });
      let item: Element | null = els[0].parentElement;
      while (item && !els.every((e) => item!.contains(e))) item = item.parentElement;
      const items = clean(item) ? [item as Element] : els.map((e) => e.closest('li') ?? e.parentElement).filter((x): x is HTMLElement => clean(x));
      for (const it of items) {
        it.setAttribute('data-k-lista', list);
        it.setAttribute('data-k-indice', String(index));
      }
    }
  }

  /** La barra de ↑ ↓ ✕ + de la lista, dentro de la vista. Elementos propios
   *  (no <button>) con estilos en línea: los de la plantilla no les llegan. */
  function listToolbar(doc: Document) {
    const win = doc.defaultView;
    if (!win) return;
    const bar = doc.createElement('k-herramientas');
    bar.setAttribute(
      'style',
      'all:initial;position:absolute;z-index:2147483647;display:none;gap:2px;padding:3px;background:#1f2937;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25);font:600 13px/1 system-ui,sans-serif',
    );
    const actions: [ListAction, string, string][] = [
      ['subir', '↑', 'Subir'],
      ['bajar', '↓', 'Bajar'],
      ['anadir', '+', 'Añadir otro después'],
      ['quitar', '✕', 'Quitar'],
    ];
    let current: Element | null = null;
    for (const [action, label, title] of actions) {
      const b = doc.createElement('k-boton');
      b.textContent = label;
      b.title = title;
      b.setAttribute('role', 'button');
      b.setAttribute('aria-label', title);
      b.setAttribute('style', `all:initial;display:inline-block;cursor:pointer;color:${action === 'quitar' ? '#fca5a5' : '#fff'};padding:5px 8px;border-radius:6px;font:inherit;user-select:none`);
      b.addEventListener('mouseenter', () => (b.style.background = '#374151'));
      b.addEventListener('mouseleave', () => (b.style.background = 'transparent'));
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!current) return;
        cb.current.onListAction?.(current.getAttribute('data-k-lista') ?? '', Number(current.getAttribute('data-k-indice')), action);
        bar.style.display = 'none';
      });
      bar.appendChild(b);
    }
    doc.body.appendChild(bar);
    doc.addEventListener('mouseover', (e) => {
      const t = e.target as Element | null;
      if (t?.closest?.('k-herramientas')) return;
      const item = t?.closest?.('[data-k-lista]') ?? null;
      if (item === current) return;
      current?.classList.remove('k-lista-encima');
      current = item;
      if (!item || inlineRef.current) {
        bar.style.display = 'none';
        return;
      }
      item.classList.add('k-lista-encima');
      const r = item.getBoundingClientRect();
      bar.style.display = 'flex';
      bar.style.top = `${Math.max(0, r.top + win.scrollY - 14)}px`;
      bar.style.left = `${Math.max(0, r.right + win.scrollX - bar.offsetWidth - 6)}px`;
    });
  }

  function paint(html: string) {
    const frame = frameRef.current;
    const win = frame?.contentWindow;
    const doc = frame?.contentDocument;
    if (!frame || !win || !doc) return;
    const y = win.scrollY;
    doc.open();
    doc.write(html);
    doc.close();
    // document.open() borra los oyentes del documento: se vuelven a poner.
    const style = doc.createElement('style');
    style.textContent = PREVIEW_CSS;
    doc.head?.appendChild(style);
    doc.addEventListener(
      'click',
      (e) => {
        const t = e.target as Element | null;
        if (t?.closest?.('k-herramientas')) return;
        const dato = t?.closest?.('k-dato[data-k-ruta]') as HTMLElement | null;
        const a = t?.closest?.('a');
        // Dónde se pulsó: la sección de la página que lo contiene.
        let seccion: string | null = null;
        for (let n: Element | null = t; n && !seccion; n = n.parentElement) if (n.id && cb.current.sectionIds.includes(n.id)) seccion = n.id;
        if (dato) {
          e.preventDefault();
          e.stopPropagation();
          const bloque = dato.hasAttribute('data-k-bloque');
          if (!bloque) startInline(dato, e);
          cb.current.onPick?.({ ruta: dato.getAttribute('data-k-ruta'), seccion, inline: !bloque });
          return;
        }
        if (a) {
          e.preventDefault();
          const href = a.getAttribute('href') ?? '';
          const hash = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
          if (hash) doc.getElementById(hash)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          return;
        }
        if (seccion) cb.current.onPick?.({ ruta: null, seccion, inline: false });
      },
      true,
    );
    doc.addEventListener('submit', (e) => e.preventDefault(), true);
    if (cb.current.onListAction) {
      markListItems(doc);
      listToolbar(doc);
    }
    // El scroll de antes, ahora y cuando acaben de cargar las fotos (que
    // cambian la altura de lo que hay encima).
    const restore = () => win.scrollTo(0, y);
    restore();
    win.requestAnimationFrame(restore);
    win.addEventListener('load', restore, { once: true });
    mark(false);
  }

  // Pedir y pintar la vista con lo que hay escrito.
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(
      async () => {
        setEstado((e) => (e === 'listo' ? 'listo' : 'cargando'));
        try {
          const res = await fetch(`${apiBase}/preview${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: ctrl.signal,
          });
          if (!res.ok) {
            setEstado('error');
            return;
          }
          const html = await res.text();
          if (ctrl.signal.aborted) return;
          // Escribiendo encima: se pinta al terminar, no ahora.
          if (inlineRef.current) pendingRef.current = html;
          else paint(html);
          setEstado('listo');
        } catch {
          if (!ctrl.signal.aborted) setEstado('error');
        }
      },
      firstRef.current ? 0 : DEBOUNCE_MS,
    );
    firstRef.current = false;
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // paint solo usa refs: no tiene que relanzar la petición.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, path, body]);

  // Al abrir otra sección en el formulario, la vista va hasta ella.
  useEffect(() => {
    activeRef.current = activeAnchor;
    mark(true);
  }, [activeAnchor]);

  const virtualWidth = device === 'movil' ? MOBILE_WIDTH : DESKTOP_WIDTH;
  const scale = size.width ? Math.min(1, size.width / virtualWidth) : 1;
  const frameHeight = size.height ? size.height / scale : 800;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-kairikos-surface2" data-testid="site-live-preview">
      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div
          style={{
            width: virtualWidth,
            height: frameHeight,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            marginLeft: size.width > virtualWidth * scale ? (size.width - virtualWidth * scale) / 2 : 0,
          }}
        >
          <iframe ref={frameRef} title="Vista previa de tu web" className={`h-full w-full border-0 bg-white ${device === 'movil' ? 'shadow-lg' : ''}`} />
        </div>
        {estado === 'cargando' ? (
          <p className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs text-white">Cargando tu web…</p>
        ) : null}
        {estado === 'error' ? (
          <p className="absolute inset-x-4 top-4 rounded-lg bg-kairikos-surface p-3 text-sm text-kairikos-danger shadow" role="status">
            Ahora mismo no podemos enseñar la vista previa (puede que algún campo no cuadre). Lo que has escrito sigue aquí.
          </p>
        ) : null}
      </div>
      {onPick ? (
        <p className="border-t border-kairikos-border bg-kairikos-surface px-3 py-1.5 text-center text-xs text-kairikos-muted">
          Pulsa un texto de tu web para cambiarlo ahí mismo. Intro para terminar, Esc para deshacer.
        </p>
      ) : null}
    </div>
  );
}
