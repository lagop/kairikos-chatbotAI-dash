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
// el marco es del mismo origen que el portal, que es lo que permite seguir el
// clic en un texto (lo usa la edición directa) sin scripts metidos en la web.
// La web ya se servía desde este mismo origen en la vista previa de siempre:
// no se abre nada que no estuviera abierto.
//
// Dentro de la vista nada navega: un enlace del menú a una sección baja hasta
// ella; los demás no hacen nada (estás editando, no visitando). Los
// formularios no se envían.
//
// «Ordenador» pinta la web a 1280 px y la reduce para que quepa: a 800 px de
// verdad se vería como en una tableta y engañaría. «Móvil», a 390 px.
// =============================================================================

export type PreviewDevice = 'ordenador' | 'movil';

const DESKTOP_WIDTH = 1280;
const MOBILE_WIDTH = 390;
const DEBOUNCE_MS = 450;

/** Cómo se marca en la vista la sección que se está editando. */
const HIGHLIGHT_CSS =
  '.k-editor-activo{outline:3px solid rgba(124,58,237,.85)!important;outline-offset:-3px;transition:outline-color .3s}';

export function SiteLivePreview({
  apiBase,
  path,
  body,
  activeAnchor,
  device,
}: {
  /** Igual que el editor: la del cliente o la del operador. */
  apiBase: string;
  /** La página que se edita ('' la portada, '/servicios'…). */
  path: string;
  /** El JSON con lo que hay en el formulario ({ content, phone, address }). */
  body: string;
  /** El id de la sección o bloque que se está editando ('servicios',
   *  'bloque-historia'): la vista baja hasta él y lo marca. */
  activeAnchor: string | null;
  device: PreviewDevice;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(activeAnchor);
  const firstRef = useRef(true);
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

  /** Marca (y, si se pide, enseña) la sección que se está editando. */
  function mark(scroll: boolean) {
    const doc = frameRef.current?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll('.k-editor-activo').forEach((el) => el.classList.remove('k-editor-activo'));
    const id = activeRef.current;
    const el = id ? doc.getElementById(id) : null;
    if (!el) return;
    el.classList.add('k-editor-activo');
    if (scroll) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
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
    style.textContent = HIGHLIGHT_CSS;
    doc.head?.appendChild(style);
    doc.addEventListener(
      'click',
      (e) => {
        const a = (e.target as Element | null)?.closest?.('a');
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute('href') ?? '';
        const hash = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
        if (hash) doc.getElementById(hash)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      },
      true,
    );
    doc.addEventListener('submit', (e) => e.preventDefault(), true);
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
          paint(html);
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

  // Al abrir otra sección en el formulario, la vista baja hasta ella.
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
          <iframe
            ref={frameRef}
            title="Vista previa de tu web"
            className={`h-full w-full border-0 bg-white ${device === 'movil' ? 'shadow-lg' : ''}`}
          />
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
    </div>
  );
}
