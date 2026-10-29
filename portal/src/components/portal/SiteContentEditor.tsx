'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import type { SiteBlock, SiteBlogEntry, SiteContent, SiteSectionRef, SiteSectionType } from '@/lib/site-content';
import type { IconSymbol } from '@/lib/site-icon-symbols';
import { SiteLivePreview, type ListAction, type PreviewDevice, type PreviewPick } from './SiteLivePreview';
import { emptyHistory, historyCommand, recordStep, redoStep, undoStep } from './edit-history';

// =============================================================================
// Webs con IA, entrega 4 (27/10/2026) — el editor de la web con plantilla de
// diseño (contenido v2, ver lib/site-content.ts).
//
// La regla de siempre: el cliente cambia CONTENIDO, no estructura. Aquí eso
// incluye el orden de las secciones, ocultarlas y añadir bloques libres,
// porque todo eso es contenido para el motor (la plantilla decide cómo se ve
// cada cosa, y no se toca desde aquí).
//
// Los datos de ejemplo del borrador (precios, plazos, garantías…) se ven por
// sección con «Confirmar». Se confirma la sección ENTERA y no dato a dato: en
// la prueba del 26/10 la IA marcaba las cifras pero no afirmaciones como «el
// desplazamiento va incluido», y solo revisando la sección entera se cubren.
// Editar un dato de ejemplo también lo confirma: ya es suyo.
//
// Entrega 5 (27/10/2026): varias páginas y blog. Cada página es una lista de
// secciones; los DATOS de una sección son de la web, no de la página (los
// servicios son los mismos estén donde estén), así que poner «Servicios» en
// dos páginas enseña lo mismo en las dos. El blog va en su pestaña: una
// entrada nueva nace SIN publicar, para que una a medias no salga en la web
// al publicar otra cosa.
//
// Este archivo no importa nada de lib/ que no sean tipos: es un componente de
// cliente (ver «Rutas y libs» en CLAUDE.md). Por eso las rutas reservadas y la
// forma de un slug se repiten aquí (lib/site-content.ts es la regla).
//
// 27/10/2026: «Color y letra». El cliente elige el color de su marca (una
// muestra o el que quiera) y una de las parejas de letras de su plantilla. El
// color va tal cual al contenido; el ajuste para que se lea lo hace el motor
// al pintar (lib/site-style.ts), así que aquí no se calcula nada: lo que se
// ve de verdad es la vista previa.
//
// 29/10/2026 — revisado usándolo como un cliente. Tres cosas hacían perder
// trabajo o parecer que algo no funcionaba: «Guardar» solo estaba arriba (no se
// veía mientras se editaba una sección, ni en escritorio ni en el móvil), salir
// con cambios sin guardar no avisaba, y «Ver cómo queda» enseñaba lo último
// GUARDADO, así que un cambio recién escrito no salía. Ahora hay una barra fija
// abajo con el estado y los tres botones, se avisa al salir (también al pulsar
// un enlace del portal, que no dispara beforeunload) y «Ver cómo queda» guarda
// antes de abrir. Y la página se parte en tres pestañas (Contenido, Diseño,
// Mis datos): todo junto medía 4.600 px cerrado. Los iconos se eligen viéndolos
// (lib/site-icon-symbols.ts), no por su nombre interno.
//
// 29/10/2026 (2) — se edita a PANTALLA COMPLETA, con la web al lado: la zona de
// contenido del portal mide unos 670 px y ahí no caben formulario y web. En la
// página queda el resumen («Editar mi web»); el editor ocupa toda la ventana,
// con el formulario a la izquierda y la vista previa en vivo a la derecha
// (SiteLivePreview), que enseña lo escrito aunque no esté guardado. Abrir una
// sección lleva la vista hasta ella. El botón «atrás» del navegador cierra el
// editor sin perder nada (#editar en la dirección). En el móvil no caben las
// dos cosas: «Editar» / «Ver» cambia de una a otra.
//
// 29/10/2026 (3) — se edita también SOBRE la web: pulsar un texto en la vista
// lo cambia ahí mismo y abre su sección aquí; un párrafo con formato o
// cualquier otra cosa abre su campo aquí. Las listas se ordenan, se quitan y
// se amplían desde la vista con ↑ ↓ ✕ +, con las mismas funciones que los
// botones de aquí (que recolocan las marcas de ejemplo). Ver SiteLivePreview.
//
// 29/10/2026 (4) — deshacer y rehacer: ↶ ↷ en la barra y Ctrl+Z / Ctrl+Mayús+Z,
// aquí y sobre la vista. Cada cambio pasa por update/setContacto, que guardan
// antes lo que había (edit-history.ts). Deshacer hasta lo último guardado
// vuelve a «Todo guardado». Una foto subida y luego deshecha se queda entre
// las subidas sin usar: el servidor ya las limita (too_many_images).
//
// 29/10/2026 (5) — las fotos se cambian también pulsándolas en la vista
// (pickPhoto): se reducen y se suben igual que desde el formulario
// (uploadImage) y, si es la de un bloque, se abre su descripción, que ya no
// describe la foto nueva. Las del antes y después no se pueden pulsar: encima
// está el deslizador que las compara; esas, desde el formulario.
// =============================================================================

/** Lo mismo que RESERVED_PAGE_ROOTS en lib/site-content.ts. */
const RESERVED = ['blog', 'aviso-legal', 'privacidad', 'cookies', 'assets', 'fuentes'];

/** «Desatascos en Telde» → 'desatascos-en-telde'. */
function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

function uniqueSlug(base: string, taken: string[], fallback: string): string {
  const root = base || fallback;
  let slug = root;
  for (let n = 2; taken.includes(slug) || RESERVED.includes(slug); n++) slug = `${root}-${n}`;
  return slug;
}

const today = () => new Date().toISOString().slice(0, 10);

type View = { kind: 'pagina'; index: number } | { kind: 'blog' };

/** Lo que se deshace: todo lo que guarda «Guardar». */
type Snapshot = { content: SiteContent; phone: string; address: string };

export interface SiteContentEditorProps {
  /** Dónde guarda, publica, sube y enseña la vista previa: la del cliente
   *  ('/api/portal/website/<clientProductId>') o, desde el 28/10/2026, la del
   *  operador ('/api/admin/portal/websites/<websiteId>'), que edita la web
   *  del cliente con este mismo editor. */
  apiBase: string;
  /** El operador editando en nombre del cliente: lo dice arriba y ve el
   *  error crudo al publicar (el del servidor SFTP, que es el que le sirve). */
  operador?: { clienteNombre: string } | null;
  initialContent: SiteContent;
  phone: string | null;
  address: string | null;
  status: string;
  lastPublishedAt: string | null;
  iconIds: string[];
  /** Los dibujos de esos iconos (saneados), para elegirlos viéndolos. */
  iconSymbols?: IconSymbol[];
  /** Entrega 6: la versión cargada, para que un «Guardar» no pise lo que
   *  el SEO haya publicado mientras tanto (el servidor responde 409). */
  updatedAt?: string;
  /** 27/10/2026 — los colores y las letras que admite su plantilla
   *  (lib/site-style.ts). Null si su plantilla no admite cambios. La primera
   *  muestra y la primera pareja son las de la plantilla. */
  estilo?: {
    muestras: { nombre: string; color: string }[];
    parejas: { id: string; nombre: string; titulares: string; texto: string; hojas: string[] }[];
  } | null;
}

const SECTION_LABEL: Record<SiteSectionType, string> = {
  portada: 'Portada',
  cifras: 'Cifras destacadas',
  servicios: 'Servicios',
  sobre: 'Quiénes somos',
  proceso: 'Cómo trabajamos',
  garantias: 'Garantías',
  precios: 'Precios',
  opiniones: 'Opiniones',
  faq: 'Preguntas frecuentes',
  zona: 'Zona de trabajo',
  llamada: 'Llamada final',
  contacto: 'Contacto y horario',
};

const BLOCK_LABEL: Record<SiteBlock['tipo'], string> = {
  texto: 'Bloque de texto',
  texto_foto: 'Texto con foto',
  lista: 'Lista con iconos',
  aviso: 'Aviso destacado',
  // 28/10/2026 — los pinta el motor en cualquier plantilla (site-rich-blocks.ts).
  galeria: 'Galería de trabajos',
  antes_despues: 'Antes y después',
  catalogo: 'Catálogo de modelos',
  pestanas: 'Pestañas',
  comparativa: 'Comparativa',
  trayectoria: 'Trayectoria',
  marcas: 'Marcas y certificados',
  video: 'Vídeo',
};

/** Qué rutas de datos de ejemplo pertenecen a cada sección. */
const SECTION_PATHS: Record<SiteSectionType, string[]> = {
  portada: ['titular', 'subtitulo'],
  cifras: ['cifras'],
  servicios: ['servicios'],
  sobre: ['sobre'],
  proceso: ['proceso'],
  garantias: ['garantias'],
  precios: ['precios'],
  opiniones: [],
  faq: ['faq'],
  zona: ['zona'],
  llamada: ['llamada_accion'],
  contacto: ['horario'],
};

const ERRORS: Record<string, string> = {
  example_data_pending: 'Antes de publicar, revisa y confirma las secciones con datos de ejemplo (las marcadas en amarillo).',
  legal_data_missing: 'Antes de publicar, rellena tus datos legales: los pide la ley para el aviso legal y la privacidad.',
  publish_not_configured: 'Todavía no podemos publicar: nos falta un dato de tu alojamiento. Ya lo estamos mirando.',
  publish_failed: 'No hemos podido publicar ahora mismo. Lo estamos revisando; tus cambios están guardados.',
  invalid_content: 'Hay algún campo que no cuadra (demasiado largo o vacío donde no puede). Revisa lo último que cambiaste.',
  internal_error: 'Algo falló por nuestra parte. Tus cambios no se han perdido.',
  // Entrega 5: los motivos concretos que devuelve el guardado (issues).
  invalid_public_url: 'La dirección de tu web no parece una dirección: tiene que empezar por https:// (por ejemplo https://fontaneriasuarez.es).',
  duplicate_entry_slug: 'Dos entradas del blog tienen la misma dirección. Cambia una de las dos.',
  reserved_page_path: 'Esa dirección de página la usa la web para otra cosa (blog, aviso legal…). Ponle otro nombre a la página.',
  stale_content:
    'Tu web ha cambiado mientras la editabas (por ejemplo, tu servicio de SEO ha publicado un artículo). Copia lo que acabas de escribir y recarga la página para seguir sobre la versión nueva.',
  invalid_video_url: 'El enlace de algún vídeo no es de YouTube o Vimeo. Cópialo de la barra del navegador o del botón «Compartir».',
  too_small: 'Hay un título vacío (de una página, una entrada o una sección). Escríbelo y vuelve a guardar.',
};

function refKey(ref: SiteSectionRef): string {
  return ref.tipo === 'bloque' ? `bloques.${ref.id}` : ref.tipo;
}

function pathsFor(ref: SiteSectionRef): string[] {
  return ref.tipo === 'bloque' ? [`bloques.${ref.id}`] : SECTION_PATHS[ref.tipo];
}

function pendingIn(content: SiteContent, ref: SiteSectionRef): number {
  const prefixes = pathsFor(ref);
  return content.ejemplos.filter((e) => prefixes.some((p) => e === p || e.startsWith(`${p}.`))).length;
}

type Field = { key: string; label: string; kind?: 'text' | 'textarea' | 'icon'; max: number };

type Tab = 'contenido' | 'diseno' | 'datos';

/** El id con el que la plantilla pinta una sección o un bloque en la web. */
function anchorFor(ref: SiteSectionRef): string {
  return ref.tipo === 'bloque' ? `bloque-${ref.id}` : ref.tipo;
}

const LEAVE_WARNING = 'Tienes cambios sin guardar en tu web. Si sales ahora, se pierden.';

/** El tope de cada campo, el mismo que su casilla del formulario: editar
 *  sobre la vista no puede dejar un texto que el formulario no dejaría. */
const FIELD_MAX: [RegExp, number][] = [
  [/^titular$/, 90],
  [/^subtitulo$/, 220],
  [/^llamada_accion$/, 90],
  [/^servicios\.\d+\.nombre$/, 80],
  [/\.descripcion$/, 300],
  [/^cifras\.\d+\.valor$/, 30],
  [/^cifras\.\d+\.etiqueta$/, 90],
  [/^(proceso|garantias)\.\d+\.titulo$/, 80],
  [/^(proceso|garantias)\.\d+\.texto$/, 300],
  [/^precios\.filas\.\d+\.concepto$/, 120],
  [/\.precio$/, 40],
  [/\.detalle$/, 200],
  [/^precios\.nota$/, 200],
  [/^faq\.\d+\.pregunta$/, 160],
  [/^zona\.texto$/, 400],
  [/^zona\.lugares\.\d+\.nombre$/, 60],
  [/^horario\.\d+\.dias$/, 40],
  [/^horario\.\d+\.horas$/, 60],
  [/^bloques\.[^.]+\.titulo$/, 90],
  [/^bloques\.[^.]+\.items\.\d+\.texto$/, 160],
];

function maxFor(ruta: string): number {
  return FIELD_MAX.find(([re]) => re.test(ruta))?.[1] ?? 300;
}

/** Lo que se añade con «+» desde la vista: con un texto de partida que se
 *  ve (uno vacío no se podría pulsar para escribirlo), y el tope de cada lista. */
const LIST_NEW: [RegExp, Record<string, string>, number][] = [
  [/^servicios$/, { nombre: 'Nuevo servicio', descripcion: 'Cuéntalo en una frase.', icono: '' }, 12],
  [/^cifras$/, { valor: 'Cifra', etiqueta: 'Qué significa' }, 4],
  [/^proceso$/, { titulo: 'Nuevo paso', texto: 'Qué pasa en este paso.' }, 6],
  [/^garantias$/, { titulo: 'Nueva garantía', texto: 'En qué consiste.' }, 4],
  [/^precios\.filas$/, { concepto: 'Nuevo concepto', precio: 'Precio', detalle: '' }, 12],
  [/^faq$/, { pregunta: '¿Nueva pregunta?', respuesta: 'La respuesta.' }, 8],
  [/^zona\.lugares$/, { nombre: 'Nuevo lugar' }, 12],
  [/^horario$/, { dias: 'Días', horas: 'Horas' }, 7],
  [/^bloques\.[^.]+\.items$/, { texto: 'Nuevo punto', icono: '' }, 8],
];

export function SiteContentEditor(props: SiteContentEditorProps) {
  const router = useRouter();
  const [content, setContent] = useState<SiteContent>(props.initialContent);
  const [phone, setPhone] = useState(props.phone ?? '');
  const [address, setAddress] = useState(props.address ?? '');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newBlock, setNewBlock] = useState<SiteBlock['tipo']>('texto');
  const [newSection, setNewSection] = useState<SiteSectionType | ''>('');
  const [newPageTitle, setNewPageTitle] = useState('');
  const [view, setView] = useState<View>({ kind: 'pagina', index: 0 });
  const [autoSlugs, setAutoSlugs] = useState<Set<string>>(new Set());
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(props.updatedAt);
  const [tab, setTab] = useState<Tab>('contenido');
  const [abierto, setAbierto] = useState(false);
  const [verMovil, setVerMovil] = useState(false);
  const [device, setDevice] = useState<PreviewDevice>('ordenador');
  const [activo, setActivo] = useState<string | null>(null);
  const [abiertas, setAbiertas] = useState<Set<string>>(new Set());
  const [foco, setFoco] = useState<{ ruta: string | null; seccion: string; focus: boolean; n: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Deshacer: lo que hay ahora (al día también entre dos cambios del mismo
  // clic), lo último guardado y el historial (edit-history.ts).
  const stateRef = useRef<Snapshot>({ content: props.initialContent, phone: props.phone ?? '', address: props.address ?? '' });
  const savedRef = useRef(JSON.stringify(stateRef.current));
  const historyRef = useRef(emptyHistory<Snapshot>());
  const [historySize, setHistorySize] = useState({ past: 0, future: 0 });
  const travelRef = useRef<(cmd: 'deshacer' | 'rehacer') => void>(() => {});
  // Fotos pulsadas en la vista: el selector de archivos y a qué dato va.
  const photoInputRef = useRef<HTMLInputElement>(null);
  const photoTargetRef = useRef<{ ruta: string; seccion: string | null } | null>(null);
  // En una pantalla pequeña la vista enseña siempre el móvil: la de ordenador
  // reducida a 390 px no se lee.
  const [pantallaPequena, setPantallaPequena] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const sync = () => setPantallaPequena(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Abrir el editor deja #editar en la dirección (se puede enlazar), y
  // «atrás» lo cierra en vez de sacar al cliente de la página.
  useEffect(() => {
    const sync = () => setAbierto(window.location.hash === '#editar');
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  useEffect(() => {
    if (!abierto) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [abierto]);

  useEffect(() => {
    if (!foco) return;
    const id = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const field = foco.ruta ? panel.querySelector<HTMLElement>(`[data-ruta="${CSS.escape(foco.ruta)}"]`) : null;
      const target = field ?? panel.querySelector<HTMLElement>(`[data-seccion="${CSS.escape(foco.seccion)}"]`);
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (field && foco.focus) field.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [foco]);

  /** Se pulsó algo en la vista: su sección, abierta aquí, y su campo a la vista
   *  (con el cursor dentro si no se está editando sobre la web). */
  function pickFromPreview(pick: PreviewPick) {
    if (view.kind !== 'pagina') return;
    const ref =
      page.secciones.find((r) => anchorFor(r) === pick.seccion) ??
      (pick.ruta?.startsWith('bloques.') ? page.secciones.find((r) => r.tipo === 'bloque' && r.id === pick.ruta?.split('.')[1]) : undefined);
    if (!ref) return;
    setTab('contenido');
    setAbiertas((prev) => new Set(prev).add(refKey(ref)));
    setActivo(anchorFor(ref));
    setFoco((prev) => ({ ruta: pick.ruta, seccion: refKey(ref), focus: !pick.inline, n: (prev?.n ?? 0) + 1 }));
  }

  function listAction(list: string, index: number, action: ListAction) {
    if (action === 'quitar' && !window.confirm('¿Quitar este elemento de tu web?')) return;
    const nuevo = LIST_NEW.find(([re]) => re.test(list));
    update((d) => {
      const items = listAt(d, list);
      if (!items) return;
      if (action === 'subir') swapIn(d, list, index, index - 1);
      else if (action === 'bajar') swapIn(d, list, index, index + 1);
      else if (action === 'quitar') removeIn(d, list, index);
      else if (nuevo && items.length < nuevo[2]) insertIn(d, list, index + 1, { ...nuevo[1] });
    });
  }

  // Ctrl+Z / Ctrl+Mayús+Z en todo el editor, también con el cursor en un campo:
  // deshace pasos del editor, no letras (las letras seguidas ya son un paso).
  // Sobre la vista los recoge SiteLivePreview, que llama a travel igual.
  useEffect(() => {
    if (!abierto) return;
    const onKey = (e: KeyboardEvent) => {
      const cmd = historyCommand(e);
      if (!cmd) return;
      e.preventDefault();
      travelRef.current(cmd);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [abierto]);

  /** Se pulsó una foto en la vista: elegir otra. El selector se abre aquí,
   *  dentro del mismo clic (si no, el navegador no lo deja abrir). */
  function pickPhoto(ruta: string, seccion: string | null) {
    photoTargetRef.current = { ruta, seccion };
    photoInputRef.current?.click();
  }

  async function uploadPhoto(file: File) {
    const target = photoTargetRef.current;
    if (!target) return;
    setBusy('foto');
    setError(null);
    const result = await uploadImage(props.apiBase, file, target.ruta === 'imagenes.logo' ? 'logo' : 'foto');
    setBusy(null);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    if (target.ruta.startsWith('imagenes.')) {
      const key = target.ruta === 'imagenes.logo' ? 'logo' : 'portada';
      update((d) => void (d.imagenes = { logo: d.imagenes?.logo ?? '', portada: d.imagenes?.portada ?? '', [key]: result.path }));
      return;
    }
    setValue(target.ruta, result.path);
    // La descripción de la foto nueva (para quien no la ve y para Google), a
    // mano en el formulario: la anterior describía otra foto.
    const alt = target.ruta.replace(/\.foto$/, /\.(fotos|productos|pestanas)\.\d+\.foto$/.test(target.ruta) ? '.alt' : '.fotoAlt');
    pickFromPreview({ ruta: alt, seccion: target.seccion, inline: false });
  }

  function abrirEditor() {
    if (window.location.hash !== '#editar') window.history.pushState({ kEditor: true }, '', '#editar');
    setAbierto(true);
  }

  function cerrarEditor() {
    if ((window.history.state as { kEditor?: boolean } | null)?.kEditor) window.history.back();
    else {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setAbierto(false);
    }
  }

  // Salir con cambios sin guardar. beforeunload cubre cerrar o recargar la
  // pestaña; los enlaces del portal navegan sin recargar (Next.js) y no lo
  // disparan, así que se interceptan los clics en enlaces de la misma web.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = LEAVE_WARNING;
    };
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
      if (a.origin !== window.location.origin) return;
      if (!window.confirm(LEAVE_WARNING)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  const pageIndex = view.kind === 'pagina' ? Math.min(view.index, content.paginas.length - 1) : 0;
  const page = content.paginas[pageIndex];
  const pending = content.ejemplos.length;
  // La vista previa abre la página que se está editando. La del blog solo
  // existe con alguna entrada publicada.
  const previewPath = view.kind === 'blog' ? (content.blog.entradas.some((e) => e.publicada) ? '/blog' : '') : page.ruta ? `/${page.ruta}` : '';
  const legalMissing = (['titular', 'nif', 'domicilio', 'email'] as const).filter((k) => !content.legal[k].trim());
  const previewBody = useMemo(() => JSON.stringify({ content, phone, address }), [content, phone, address]);

  const pendingSections = useMemo(() => {
    const labels = content.paginas.flatMap((p) =>
      p.secciones.filter((r) => !r.oculta && pendingIn(content, r) > 0).map((r) => (r.tipo === 'bloque' ? 'un bloque' : SECTION_LABEL[r.tipo])),
    );
    return [...new Set(labels)];
  }, [content]);

  function addPage() {
    const titulo = newPageTitle.trim().slice(0, 30);
    if (!titulo) return;
    update((d) => {
      const ruta = uniqueSlug(slugify(titulo), d.paginas.map((p) => p.ruta), 'pagina');
      d.paginas.push({ ruta, titulo, metaTitulo: '', metaDescripcion: '', secciones: [] });
    });
    setNewPageTitle('');
    setView({ kind: 'pagina', index: content.paginas.length });
  }

  function removePage(index: number) {
    if (index === 0 || !window.confirm('¿Quitar esta página de tu web? Sus secciones siguen guardadas y puedes ponerlas en otra.')) return;
    update((d) => {
      d.paginas.splice(index, 1);
    });
    setView({ kind: 'pagina', index: 0 });
  }

  function movePage(index: number, delta: number) {
    const to = index + delta;
    // La portada se queda la primera: es la dirección raíz de la web.
    if (index === 0 || to < 1 || to >= content.paginas.length) return;
    update((d) => {
      [d.paginas[index], d.paginas[to]] = [d.paginas[to], d.paginas[index]];
    });
    setView({ kind: 'pagina', index: to });
  }

  function addSection() {
    if (!newSection) return;
    update((d) => {
      d.paginas[pageIndex].secciones.push({ tipo: newSection });
    });
    setNewSection('');
  }

  function newEntry() {
    const slug = uniqueSlug('entrada', content.blog.entradas.map((e) => e.slug), 'entrada');
    setAutoSlugs((prev) => new Set(prev).add(slug));
    update((d) => {
      d.blog.entradas.unshift({ slug, titulo: 'Nueva entrada', metaTitulo: '', metaDescripcion: '', fecha: today(), extracto: '', texto: '', foto: '', fotoAlt: '', publicada: false, origen: 'cliente', html: '' });
    });
  }

  /** La dirección de una entrada creada en esta sesión sigue a su título
   *  hasta que el cliente la toca a mano. Las que ya existían no cambian
   *  solas: puede haber enlaces apuntándolas. */
  function setEntry(index: number, patch: Partial<SiteBlogEntry>) {
    const entry = content.blog.entradas[index];
    let slug = patch.slug ?? entry.slug;
    if (patch.slug !== undefined) {
      setAutoSlugs((prev) => {
        const next = new Set(prev);
        next.delete(entry.slug);
        return next;
      });
    } else if (patch.titulo !== undefined && autoSlugs.has(entry.slug)) {
      const others = content.blog.entradas.filter((_, i) => i !== index).map((e) => e.slug);
      slug = uniqueSlug(slugify(patch.titulo), others, 'entrada');
      setAutoSlugs((prev) => {
        const next = new Set(prev);
        next.delete(entry.slug);
        return next.add(slug);
      });
    }
    update((d) => {
      Object.assign(d.blog.entradas[index], patch, { slug });
    });
  }

  function removeEntry(index: number) {
    if (!window.confirm('¿Borrar esta entrada? Si estaba publicada, desaparece de tu web al volver a publicar.')) return;
    update((d) => {
      d.blog.entradas.splice(index, 1);
    });
  }

  /** Antes de cada cambio, lo que había, para deshacerlo (edit-history.ts).
   *  Sin `key` explícito, lo que se escribe en un campo del formulario se
   *  junta en un paso; un clic, una lista o un desplegable van cada uno solo. */
  function record(key?: unknown) {
    const typing = typeof window !== 'undefined' && window.event?.type === 'input' ? document.activeElement : null;
    historyRef.current = recordStep(historyRef.current, stateRef.current, key ?? typing, Date.now());
    setHistorySize({ past: historyRef.current.past.length, future: 0 });
  }

  // Síncrono sobre stateRef y no con setContent(prev => …): así dos cambios en
  // el mismo clic se encadenan y el historial guarda lo que de verdad había.
  function update(mutate: (draft: SiteContent) => void, key?: unknown) {
    const next = structuredClone(stateRef.current.content);
    mutate(next);
    record(key);
    stateRef.current = { ...stateRef.current, content: next };
    setContent(next);
    setDirty(true);
    setMessage(null);
  }

  function setContacto(patch: { phone?: string; address?: string }) {
    record();
    stateRef.current = { ...stateRef.current, ...patch };
    if (patch.phone !== undefined) setPhone(patch.phone);
    if (patch.address !== undefined) setAddress(patch.address);
    setDirty(true);
    setMessage(null);
  }

  /** Deshacer o rehacer. Volver justo a lo guardado deja «Todo guardado». */
  function travel(cmd: 'deshacer' | 'rehacer') {
    const step = (cmd === 'deshacer' ? undoStep : redoStep)(historyRef.current, stateRef.current);
    if (!step) return;
    historyRef.current = step.history;
    stateRef.current = step.value;
    setContent(step.value.content);
    setPhone(step.value.phone);
    setAddress(step.value.address);
    setDirty(JSON.stringify(step.value) !== savedRef.current);
    setMessage(null);
    setHistorySize({ past: step.history.past.length, future: step.history.future.length });
  }
  travelRef.current = travel;

  /** Cambia un dato y, si era de ejemplo, deja de serlo: lo ha escrito él.
   *  Escribir seguido en el mismo dato (aquí o sobre la web) es un solo paso. */
  function setValue(path: string, value: string) {
    update((d) => {
      const parts = path.split('.');
      let target: Record<string, unknown> | unknown[] = parts[0] === 'bloques' ? (d.bloques.find((b) => b.id === parts[1]) as unknown as Record<string, unknown>) : (d.datos as unknown as Record<string, unknown>);
      const rest = parts[0] === 'bloques' ? parts.slice(2) : parts;
      for (const p of rest.slice(0, -1)) target = (target as Record<string, unknown>)[p] as Record<string, unknown>;
      (target as Record<string, unknown>)[rest[rest.length - 1]] = value;
      d.ejemplos = d.ejemplos.filter((e) => e !== path);
    }, path);
  }

  function setStyle(patch: { acento?: string; tipografia?: string }) {
    update((d) => {
      d.estilo = { acento: d.estilo?.acento ?? '', tipografia: d.estilo?.tipografia ?? '', ...patch };
    });
  }

  function confirmSection(ref: SiteSectionRef) {
    const prefixes = pathsFor(ref);
    update((d) => {
      d.ejemplos = d.ejemplos.filter((e) => !prefixes.some((p) => e === p || e.startsWith(`${p}.`)));
      if (!d.seccionesConfirmadas.includes(refKey(ref))) d.seccionesConfirmadas.push(refKey(ref));
    });
  }

  function move(index: number, delta: number) {
    update((d) => {
      const list = d.paginas[pageIndex].secciones;
      const to = index + delta;
      if (to < 0 || to >= list.length) return;
      [list[index], list[to]] = [list[to], list[index]];
    });
  }

  function addBlock() {
    update((d) => {
      let n = d.bloques.length + 1;
      while (d.bloques.some((b) => b.id === `bloque-${n}`)) n++;
      const id = `bloque-${n}`;
      d.bloques.push({ id, tipo: newBlock, titulo: '', texto: '', foto: '', fotoAlt: '', items: newBlock === 'lista' ? [{ texto: '', icono: '' }] : [], fotos: newBlock === 'antes_despues' ? [{ foto: '', alt: '', texto: 'Antes' }, { foto: '', alt: '', texto: 'Después' }] : [], productos: [], pestanas: [], comparativa: { columnas: [], destacada: -1, filas: [] }, hitos: [], video: '' });
      const list = d.paginas[pageIndex].secciones;
      const contacto = list.findIndex((s) => s.tipo === 'contacto');
      list.splice(contacto >= 0 ? contacto : list.length, 0, { tipo: 'bloque', id });
    });
  }

  function removeBlock(id: string) {
    update((d) => {
      d.bloques = d.bloques.filter((b) => b.id !== id);
      d.paginas.forEach((p) => (p.secciones = p.secciones.filter((s) => !(s.tipo === 'bloque' && s.id === id))));
      d.ejemplos = d.ejemplos.filter((e) => !e.startsWith(`bloques.${id}.`));
    });
  }

  async function save(): Promise<boolean> {
    setBusy('save');
    setError(null);
    const sent = stateRef.current;
    const res = await fetch(`${props.apiBase}/content`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: sent.content, phone: sent.phone || null, address: sent.address || null, baseUpdatedAt }),
    });
    setBusy(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: { message: string; path: string }[] };
      const specific = body.issues?.map((i) => (i.message.startsWith('String must contain at least') ? 'too_small' : i.message)).find((m) => m in ERRORS);
      setError(ERRORS[specific ?? body.error ?? 'internal_error'] ?? ERRORS.internal_error);
      return false;
    }
    const saved = (await res.json().catch(() => ({}))) as { updatedAt?: string };
    if (saved.updatedAt) setBaseUpdatedAt(saved.updatedAt);
    savedRef.current = JSON.stringify(sent);
    // Si se siguió escribiendo mientras se guardaba, eso aún no está guardado.
    setDirty(stateRef.current !== sent);
    setMessage('Guardado. Tu web publicada no cambia hasta que pulses «Publicar».');
    return true;
  }

  /** Abre la vista previa con lo que hay ahora: si hay cambios, guarda antes.
   *  La pestaña se abre YA, dentro del clic (si no, el navegador la bloquea
   *  como ventana emergente), y se lleva a la vista previa al terminar. */
  async function openPreview() {
    const url = `${props.apiBase}/preview${previewPath}`;
    if (!dirty) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    const win = window.open('about:blank', '_blank');
    if (await save()) {
      if (win) win.location.href = url;
      else window.open(url, '_blank', 'noopener');
    } else {
      win?.close();
    }
  }

  async function publish() {
    if (dirty && !(await save())) return;
    setBusy('publish');
    setError(null);
    const res = await fetch(`${props.apiBase}/publish`, { method: 'POST' });
    setBusy(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // Al operador, el motivo tal cual: «Permission denied» del SFTP del
      // cliente es justo lo que necesita saber para arreglarlo.
      if (props.operador && body.error && !(body.error in ERRORS)) {
        setError(body.error === 'credential_missing' ? 'Falta la credencial de SFTP de su alojamiento: pégala en la ficha del cliente.' : `No se pudo publicar: ${body.error}`);
        return;
      }
      setError(ERRORS[body.error ?? 'publish_failed'] ?? ERRORS.publish_failed);
      return;
    }
    setMessage(props.operador ? 'Publicada. Los cambios ya están en su web.' : 'Publicada. Los cambios ya están en tu web.');
    router.refresh();
  }

  const listEditor = (path: string, items: Record<string, string>[], fields: Field[], empty: Record<string, string>, max: number) => (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="rounded-lg border border-kairikos-border p-3 space-y-2">
          {fields.map((f) => (
            <FieldInput key={f.key} ruta={`${path}.${i}.${f.key}`} field={f} value={item[f.key] ?? ''} iconIds={props.iconIds} icons={props.iconSymbols} example={content.ejemplos.includes(`${path}.${i}.${f.key}`)} onChange={(v) => setValue(`${path}.${i}.${f.key}`, v)} />
          ))}
          <div className="flex gap-2 text-xs">
            <button type="button" className="btn-ghost" disabled={i === 0} onClick={() => update((d) => swapIn(d, path, i, i - 1))}>
              Subir
            </button>
            <button type="button" className="btn-ghost" disabled={i === items.length - 1} onClick={() => update((d) => swapIn(d, path, i, i + 1))}>
              Bajar
            </button>
            <button type="button" className="btn-ghost text-kairikos-danger" onClick={() => update((d) => removeIn(d, path, i))}>
              Quitar
            </button>
          </div>
        </div>
      ))}
      {items.length < max ? (
        <button type="button" className="btn-ghost text-sm" onClick={() => update((d) => (listAt(d, path) as unknown[]).push({ ...empty }))}>
          + Añadir
        </button>
      ) : null}
    </div>
  );

  function sectionEditor(ref: SiteSectionRef) {
    const d = content.datos;
    const text = (label: string, path: string, value: string, max: number, kind: Field['kind'] = 'text') => (
      <FieldInput ruta={path} field={{ key: path, label, kind, max }} value={value} iconIds={props.iconIds} icons={props.iconSymbols} example={content.ejemplos.includes(path)} onChange={(v) => setValue(path, v)} />
    );
    if (ref.tipo === 'bloque') {
      const b = content.bloques.find((x) => x.id === ref.id);
      if (!b) return null;
      const base = `bloques.${b.id}`;
      return (
        <div className="space-y-3">
          {text('Título', `${base}.titulo`, b.titulo, 90)}
          {text('Texto (puedes usar **negrita**, listas con «- » y enlaces [texto](https://…))', `${base}.texto`, b.texto, 2000, 'textarea')}
          {b.tipo === 'lista'
            ? listEditor(`${base}.items`, b.items as unknown as Record<string, string>[], [{ key: 'texto', label: 'Punto', max: 160 }, { key: 'icono', label: 'Icono', kind: 'icon', max: 40 }], { texto: '', icono: '' }, 8)
            : null}
          {b.tipo === 'texto_foto' ? (
            <>
              <ImagePicker
                apiBase={props.apiBase}
                label="Foto"
                help="Una foto tuya: un trabajo, tu equipo, tu local."
                value={b.foto}
                kind="foto"
                onChange={(path) => update((d) => void ((d.bloques.find((x) => x.id === b.id) as SiteBlock).foto = path))}
              />
              {text('Qué se ve en la foto (para quien no puede verla y para Google)', `${base}.fotoAlt`, b.fotoAlt, 160)}
            </>
          ) : null}
          {b.tipo === 'video' ? (
            <div className="space-y-3">
              <label className="block text-sm font-medium">
                Enlace del vídeo (YouTube o Vimeo)
                <input
                  className={`input mt-1 w-full ${b.video && !isVideoUrl(b.video) ? 'border-kairikos-danger' : ''}`}
                  maxLength={300}
                  placeholder="https://www.youtube.com/watch?v=…"
                  value={b.video}
                  onChange={(e) => update((d) => void ((d.bloques.find((x) => x.id === b.id) as SiteBlock).video = e.target.value.trim()))}
                />
              </label>
              {b.video && !isVideoUrl(b.video) ? <p className="text-xs text-kairikos-danger">Ese enlace no es de un vídeo de YouTube o Vimeo. Cópialo de la barra del navegador o del botón «Compartir».</p> : null}
              <p className="text-xs text-kairikos-muted">
                Tu web no carga nada de YouTube o Vimeo hasta que el visitante pulsa el vídeo; así no hace falta pedirle permiso para cookies al entrar. Las páginas de
                cookies y privacidad de tu web lo explican solas.
              </p>
              <ImagePicker
                apiBase={props.apiBase}
                label="Portada (opcional)"
                help="Una foto que se ve antes de pulsar. Sin ella, una portada con los colores de tu web."
                value={b.foto}
                kind="foto"
                onChange={(path) => update((d) => void ((d.bloques.find((x) => x.id === b.id) as SiteBlock).foto = path))}
              />
            </div>
          ) : null}
          {b.tipo === 'pestanas' ? (
            <TabsEditor apiBase={props.apiBase} pestanas={b.pestanas} onChange={(pestanas) => update((d) => void ((d.bloques.find((x) => x.id === b.id) as SiteBlock).pestanas = pestanas))} />
          ) : null}
          {b.tipo === 'comparativa' ? (
            <ComparisonEditor value={b.comparativa} onChange={(comparativa) => update((d) => void ((d.bloques.find((x) => x.id === b.id) as SiteBlock).comparativa = comparativa))} />
          ) : null}
          {b.tipo === 'trayectoria' ? (
            <MilestonesEditor hitos={b.hitos} onChange={(hitos) => update((d) => void ((d.bloques.find((x) => x.id === b.id) as SiteBlock).hitos = hitos))} />
          ) : null}
          {b.tipo === 'galeria' || b.tipo === 'antes_despues' || b.tipo === 'marcas' ? (
            <RichPhotosEditor
              apiBase={props.apiBase}
              mode={b.tipo}
              fotos={b.fotos}
              onChange={(fotos) => update((d) => void ((d.bloques.find((x) => x.id === b.id) as SiteBlock).fotos = fotos))}
            />
          ) : null}
          {b.tipo === 'catalogo' ? (
            <CatalogEditor
              apiBase={props.apiBase}
              productos={b.productos}
              onChange={(productos) => update((d) => void ((d.bloques.find((x) => x.id === b.id) as SiteBlock).productos = productos))}
            />
          ) : null}
          <button type="button" className="btn-ghost text-sm text-kairikos-danger" onClick={() => removeBlock(b.id)}>
            Quitar este bloque
          </button>
        </div>
      );
    }
    switch (ref.tipo) {
      case 'portada':
        return (
          <div className="space-y-3">
            {text('Titular', 'titular', d.titular, 90)}
            {text('Subtítulo', 'subtitulo', d.subtitulo, 220, 'textarea')}
            {text('Texto del botón de llamar', 'llamada_accion', d.llamada_accion, 90)}
          </div>
        );
      case 'llamada':
        return text('Frase de la llamada final', 'llamada_accion', d.llamada_accion, 90);
      case 'sobre':
        return text('Quiénes sois (puedes usar **negrita**, listas con «- » y enlaces)', 'sobre', d.sobre, 1200, 'textarea');
      case 'servicios':
        return listEditor('servicios', d.servicios, [{ key: 'nombre', label: 'Servicio', max: 80 }, { key: 'descripcion', label: 'Descripción', kind: 'textarea', max: 300 }, { key: 'icono', label: 'Icono', kind: 'icon', max: 40 }], { nombre: '', descripcion: '', icono: '' }, 12);
      case 'cifras':
        return listEditor('cifras', d.cifras, [{ key: 'valor', label: 'Cifra', max: 30 }, { key: 'etiqueta', label: 'Qué es', max: 90 }], { valor: '', etiqueta: '' }, 4);
      case 'proceso':
        return listEditor('proceso', d.proceso, [{ key: 'titulo', label: 'Paso', max: 80 }, { key: 'texto', label: 'Explicación', kind: 'textarea', max: 300 }], { titulo: '', texto: '' }, 6);
      case 'garantias':
        return listEditor('garantias', d.garantias, [{ key: 'titulo', label: 'Garantía', max: 80 }, { key: 'texto', label: 'Explicación', kind: 'textarea', max: 300 }], { titulo: '', texto: '' }, 4);
      case 'precios':
        return (
          <div className="space-y-3">
            {listEditor('precios.filas', d.precios.filas, [{ key: 'concepto', label: 'Concepto', max: 120 }, { key: 'precio', label: 'Precio', max: 40 }, { key: 'detalle', label: 'Detalle', max: 200 }], { concepto: '', precio: '', detalle: '' }, 12)}
            {text('Nota bajo los precios', 'precios.nota', d.precios.nota, 200)}
          </div>
        );
      case 'faq':
        return listEditor('faq', d.faq, [{ key: 'pregunta', label: 'Pregunta', max: 160 }, { key: 'respuesta', label: 'Respuesta', kind: 'textarea', max: 1200 }], { pregunta: '', respuesta: '' }, 8);
      case 'zona':
        return (
          <div className="space-y-3">
            {text('Dónde trabajáis', 'zona.texto', d.zona.texto, 400, 'textarea')}
            {listEditor('zona.lugares', d.zona.lugares, [{ key: 'nombre', label: 'Lugar', max: 60 }], { nombre: '' }, 12)}
          </div>
        );
      case 'contacto':
        return listEditor('horario', d.horario, [{ key: 'dias', label: 'Días', max: 40 }, { key: 'horas', label: 'Horas', max: 60 }], { dias: '', horas: '' }, 7);
      case 'opiniones':
        return <p className="text-sm text-kairikos-muted">Las opiniones salen de Google cuando tienes contratado el servicio de reseñas; aquí no hay nada que escribir.</p>;
    }
  }

  const statusCard = (
      <div className="card space-y-3">
        {props.operador ? (
          <p className="rounded-lg bg-kairikos-warning/10 px-3 py-2 text-sm" data-testid="site-editor-operator">
            Estás editando la web de <strong>{props.operador.clienteNombre}</strong> como operador. Es la misma web que ve el cliente en su
            portal: lo que guardes lo verá él, y queda en la auditoría a tu nombre.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">{props.operador ? 'Su web' : 'Tu web'}</p>
          <span className={props.status === 'published' ? 'pill-success' : 'pill-muted'}>{props.status === 'published' ? 'Publicada' : 'Sin publicar'}</span>
          {props.lastPublishedAt ? <span className="text-xs text-kairikos-muted">Última publicación: {new Date(props.lastPublishedAt).toLocaleString('es-ES')}</span> : null}
        </div>
        {pending > 0 ? (
          <p className="text-sm text-kairikos-warning" data-testid="site-editor-pending">
            Quedan {pending} datos de ejemplo por revisar en: {pendingSections.join(', ')}. Cámbialos por los tuyos o confirma cada sección.
          </p>
        ) : null}
        {legalMissing.length ? (
          <p className="text-sm text-kairikos-warning">
            Faltan tus datos legales:{' '}
            <button type="button" className="underline" onClick={() => setTab('datos')}>
              rellénalos en «Mis datos»
            </button>
            ; sin ellos no se puede publicar.
          </p>
        ) : null}
      </div>
  );

  const editorBody = (
    <>
      {/* Tres pestañas: lo que se escribe, cómo se ve y los datos del negocio. */}
      <div role="tablist" aria-label="Partes de tu web" className="flex flex-wrap gap-2 border-b border-kairikos-border pb-2">
        {(
          [
            ['contenido', 'Contenido', pending],
            ['diseno', 'Diseño', 0],
            ['datos', 'Mis datos', legalMissing.length],
          ] as const
        ).map(([key, label, aviso]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'btn-primary' : 'btn-ghost'}
            onClick={() => setTab(key)}
            data-testid={`site-editor-tab-${key}`}
          >
            {label}
            {aviso ? <span className="ml-2 pill-warning">{aviso}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'diseno' && props.estilo ? <StyleCard estilo={props.estilo} value={content.estilo} onChange={setStyle} /> : null}

      {tab === 'diseno' ? (
      <div className="card space-y-4" data-testid="site-editor-images">
        <div>
          <p className="font-semibold">Logo y foto de portada</p>
          <p className="text-sm text-kairikos-muted">
            Con tu logo, la cabecera de tu web lo enseña en vez de tu nombre escrito. Con tu foto, la portada lleva la tuya en vez de la de muestra
            de tu oficio. Las reducimos al subirlas y les quitamos los datos de la cámara (como el lugar donde se hizo la foto).
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <ImagePicker
            apiBase={props.apiBase}
            label="Logo"
            help="Mejor en PNG con fondo transparente."
            value={content.imagenes?.logo ?? ''}
            kind="logo"
            onChange={(path) => update((d) => void (d.imagenes = { logo: path, portada: d.imagenes?.portada ?? '' }))}
          />
          <ImagePicker
            apiBase={props.apiBase}
            label="Foto de portada"
            help="Horizontal, de un trabajo tuyo. Sin ella, va la de muestra de tu oficio."
            value={content.imagenes?.portada ?? ''}
            kind="foto"
            onChange={(path) => update((d) => void (d.imagenes = { logo: d.imagenes?.logo ?? '', portada: path }))}
          />
        </div>
      </div>
      ) : null}

      {tab === 'contenido' ? (
      <>
      {/* Las páginas y el blog. La portada siempre la primera: es la raíz. */}
      <nav className="flex flex-wrap gap-2" aria-label="Páginas de tu web">
        {content.paginas.map((p, i) => (
          <button
            key={p.ruta || 'inicio'}
            type="button"
            className={view.kind === 'pagina' && pageIndex === i ? 'btn-primary' : 'btn-ghost'}
            aria-current={view.kind === 'pagina' && pageIndex === i ? 'page' : undefined}
            onClick={() => setView({ kind: 'pagina', index: i })}
          >
            {i === 0 ? `${p.titulo} (portada)` : p.titulo}
          </button>
        ))}
        <button type="button" className={view.kind === 'blog' ? 'btn-primary' : 'btn-ghost'} aria-current={view.kind === 'blog' ? 'page' : undefined} onClick={() => setView({ kind: 'blog' })}>
          {content.blog.titulo} ({content.blog.entradas.filter((e) => e.publicada).length})
        </button>
      </nav>

      {view.kind === 'blog' ? (
        <div className="space-y-4" data-testid="site-editor-blog">
          <div className="card space-y-3">
            <p className="font-semibold">Blog</p>
            <p className="text-sm text-kairikos-muted">
              Cada entrada es una página de tu web con su propia dirección, buena para salir en Google cuando alguien busca lo que explicas. El enlace «{content.blog.titulo}» aparece en el menú en cuanto publicas la primera.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                Nombre en el menú
                <input className="input mt-1 w-full" maxLength={30} value={content.blog.titulo} onChange={(e) => update((d) => (d.blog.titulo = e.target.value))} />
              </label>
              <label className="text-sm">
                Frase de presentación
                <input className="input mt-1 w-full" maxLength={300} value={content.blog.intro} onChange={(e) => update((d) => (d.blog.intro = e.target.value))} />
              </label>
            </div>
            <button type="button" className="btn-primary" onClick={newEntry} disabled={content.blog.entradas.length >= 200}>
              Nueva entrada
            </button>
          </div>
          <ol className="space-y-2">
            {content.blog.entradas.map((entry, i) => (
              <li key={i} className="card">
                <details open={autoSlugs.has(entry.slug)}>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                    <span className="font-medium">{entry.titulo || 'Sin título'}</span>
                    <span className={entry.publicada ? 'pill-success' : 'pill-muted'}>{entry.publicada ? 'Publicada' : 'Sin publicar'}</span>
                    {entry.origen === 'seo' ? <span className="pill-muted">SEO</span> : null}
                    <span className="text-xs text-kairikos-muted">{entry.fecha}</span>
                  </summary>
                  <div className="mt-4 space-y-3">
                    <label className="block text-sm">
                      Título
                      <input className="input mt-1 w-full" maxLength={120} value={entry.titulo} onChange={(e) => setEntry(i, { titulo: e.target.value })} />
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-sm">
                        Dirección: /blog/{entry.slug}/
                        <input className="input mt-1 w-full" maxLength={80} value={entry.slug} onChange={(e) => setEntry(i, { slug: slugify(e.target.value) || entry.slug })} />
                        <span className="text-xs text-kairikos-muted">Una vez publicada, mejor no cambiarla: los enlaces a la antigua dejarían de funcionar.</span>
                      </label>
                      <label className="text-sm">
                        Fecha
                        <input type="date" className="input mt-1 w-full" value={entry.fecha} onChange={(e) => e.target.value && setEntry(i, { fecha: e.target.value })} />
                      </label>
                    </div>
                    {entry.html ? (
                      // Entrega 6: los artículos del SEO llegan ya escritos (y
                      // aprobados por ti en la página de SEO). Aquí se puede
                      // retocar el título, la fecha o despublicar; el texto
                      // se cambia pidiendo una revisión desde SEO.
                      <p className="rounded-lg border border-kairikos-border p-3 text-sm text-kairikos-muted">
                        Este artículo lo escribió tu servicio de SEO y lo aprobaste en la página de SEO. Puedes cambiar el título, la fecha o dejar de publicarlo; para cambiar el texto, pídenoslo desde soporte.
                      </p>
                    ) : (
                      <label className="block text-sm">
                        Texto (**negrita**, «## » para un subtítulo, listas con «- » y enlaces [texto](https://…))
                        <textarea className="input mt-1 w-full" rows={14} maxLength={20000} value={entry.texto} onChange={(e) => setEntry(i, { texto: e.target.value })} />
                      </label>
                    )}
                    <label className="block text-sm">
                      Resumen para la lista del blog (si lo dejas vacío, se usa el principio del texto)
                      <textarea className="input mt-1 w-full" rows={2} maxLength={300} value={entry.extracto} onChange={(e) => setEntry(i, { extracto: e.target.value })} />
                    </label>
                    <details className="text-sm">
                      <summary className="cursor-pointer">Cómo sale en Google (opcional)</summary>
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <label>
                          Título para Google
                          <input className="input mt-1 w-full" maxLength={70} value={entry.metaTitulo} onChange={(e) => setEntry(i, { metaTitulo: e.target.value })} />
                        </label>
                        <label>
                          Descripción para Google
                          <input className="input mt-1 w-full" maxLength={160} value={entry.metaDescripcion} onChange={(e) => setEntry(i, { metaDescripcion: e.target.value })} />
                        </label>
                      </div>
                    </details>
                    <div className="flex flex-wrap items-center gap-3 border-t border-kairikos-border pt-3 text-sm">
                      <label className="flex items-center gap-2">
                        <input type="checkbox" checked={entry.publicada} onChange={(e) => setEntry(i, { publicada: e.target.checked })} />
                        Publicar esta entrada (sale en tu web la próxima vez que pulses «Publicar»)
                      </label>
                      <button type="button" className="btn-ghost text-kairikos-danger" onClick={() => removeEntry(i)}>
                        Borrar entrada
                      </button>
                    </div>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <>
          <div className="card space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm">
                Nombre en el menú
                <input className="input mt-1 w-full" maxLength={30} value={page.titulo} onChange={(e) => update((d) => (d.paginas[pageIndex].titulo = e.target.value))} />
              </label>
              <p className="text-sm text-kairikos-muted sm:pt-6">Dirección: /{page.ruta ? `${page.ruta}/` : ''}</p>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer">Cómo sale en Google (opcional)</summary>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <label>
                  Título para Google
                  <input className="input mt-1 w-full" maxLength={70} value={page.metaTitulo} onChange={(e) => update((d) => (d.paginas[pageIndex].metaTitulo = e.target.value))} />
                </label>
                <label>
                  Descripción para Google
                  <input className="input mt-1 w-full" maxLength={160} value={page.metaDescripcion} onChange={(e) => update((d) => (d.paginas[pageIndex].metaDescripcion = e.target.value))} />
                </label>
              </div>
            </details>
            {pageIndex > 0 ? (
              <div className="flex flex-wrap gap-2 text-sm">
                <button type="button" className="btn-ghost" disabled={pageIndex === 1} onClick={() => movePage(pageIndex, -1)}>
                  Antes en el menú
                </button>
                <button type="button" className="btn-ghost" disabled={pageIndex === content.paginas.length - 1} onClick={() => movePage(pageIndex, 1)}>
                  Después en el menú
                </button>
                <button type="button" className="btn-ghost text-kairikos-danger" onClick={() => removePage(pageIndex)}>
                  Quitar esta página
                </button>
              </div>
            ) : null}
            {content.paginas.length > 6 ? <p className="text-xs text-kairikos-warning">En el menú caben cinco enlaces: las páginas de más siguen existiendo, pero no salen en él.</p> : null}
          </div>

          {page.secciones.length === 0 ? <p className="card text-sm text-kairikos-muted">Esta página está vacía: añádele secciones o bloques aquí debajo.</p> : null}
          <ol className="space-y-2">
            {page.secciones.map((ref, i) => {
              const examples = pendingIn(content, ref);
              const block = ref.tipo === 'bloque' ? content.bloques.find((b) => b.id === ref.id) : null;
              const label = ref.tipo === 'bloque' ? `${block ? BLOCK_LABEL[block.tipo] : 'Bloque'}${block?.titulo ? `: ${block.titulo}` : ''}` : SECTION_LABEL[ref.tipo];
              return (
                <li key={refKey(ref)} className={`card ${ref.oculta ? 'opacity-60' : ''}`} onFocusCapture={() => setActivo(anchorFor(ref))} data-seccion={refKey(ref)}>
                  <details
                    open={abiertas.has(refKey(ref))}
                    onToggle={(e) => {
                      const open = e.currentTarget.open;
                      setAbiertas((prev) => {
                        if (prev.has(refKey(ref)) === open) return prev;
                        const next = new Set(prev);
                        if (open) next.add(refKey(ref));
                        else next.delete(refKey(ref));
                        return next;
                      });
                      if (open) setActivo(anchorFor(ref));
                    }}
                  >
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                      <span className="font-medium">{label}</span>
                      {ref.oculta ? <span className="pill-muted">Oculta</span> : null}
                      {examples > 0 ? <span className="pill-warning">{examples} de ejemplo</span> : null}
                    </summary>
                    <div className="mt-4 space-y-4">
                      {sectionEditor(ref)}
                      <div className="flex flex-wrap gap-2 border-t border-kairikos-border pt-3 text-sm">
                        <button type="button" className="btn-ghost" disabled={i === 0} onClick={() => move(i, -1)}>
                          Subir sección
                        </button>
                        <button type="button" className="btn-ghost" disabled={i === page.secciones.length - 1} onClick={() => move(i, 1)}>
                          Bajar sección
                        </button>
                        {ref.tipo !== 'portada' && ref.tipo !== 'contacto' ? (
                          <button type="button" className="btn-ghost" onClick={() => update((d) => (d.paginas[pageIndex].secciones[i].oculta = !ref.oculta))}>
                            {ref.oculta ? 'Mostrar en la web' : 'Ocultar de la web'}
                          </button>
                        ) : null}
                        {examples > 0 ? (
                          <button type="button" className="btn-primary" onClick={() => confirmSection(ref)}>
                            Confirmar sección: lo que pone es cierto
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>

          <div className="card flex flex-wrap items-center gap-2">
            <span className="text-sm">Añadir a esta página</span>
            <select className="input" value={newSection} onChange={(e) => setNewSection(e.target.value as SiteSectionType | '')} aria-label="Sección">
              <option value="">Una sección…</option>
              {(Object.keys(SECTION_LABEL) as SiteSectionType[])
                .filter((t) => !page.secciones.some((s) => s.tipo === t))
                .map((t) => (
                  <option key={t} value={t}>
                    {SECTION_LABEL[t]}
                  </option>
                ))}
            </select>
            <button type="button" className="btn-ghost" onClick={addSection} disabled={!newSection}>
              Añadir sección
            </button>
            <select className="input" value={newBlock} onChange={(e) => setNewBlock(e.target.value as SiteBlock['tipo'])} aria-label="Tipo de bloque">
              {(Object.keys(BLOCK_LABEL) as SiteBlock['tipo'][]).map((t) => (
                <option key={t} value={t}>
                  {BLOCK_LABEL[t]}
                </option>
              ))}
            </select>
            <button type="button" className="btn-ghost" onClick={addBlock} disabled={content.bloques.length >= 12}>
              Añadir bloque
            </button>
            <span className="text-xs text-kairikos-muted">Los datos de una sección son de toda la web: «Servicios» en dos páginas enseña lo mismo en las dos.</span>
          </div>

          <div className="card flex flex-wrap items-center gap-2">
            <label className="text-sm" htmlFor="nueva-pagina">Nueva página</label>
            <input id="nueva-pagina" className="input" maxLength={30} placeholder="Por ejemplo: Desatascos" value={newPageTitle} onChange={(e) => setNewPageTitle(e.target.value)} />
            <button type="button" className="btn-ghost" onClick={addPage} disabled={!newPageTitle.trim() || content.paginas.length >= 20}>
              Crear página
            </button>
          </div>
        </>
      )}
      </>
      ) : null}

      {tab === 'datos' ? (
      <div className="card space-y-3" data-testid="site-editor-datos">
        <p className="font-semibold">Contacto y datos legales</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Teléfono
            <input className="input mt-1 w-full" maxLength={50} value={phone} onChange={(e) => setContacto({ phone: e.target.value })} />
          </label>
          <label className="text-sm">
            Dirección
            <input className="input mt-1 w-full" maxLength={300} value={address} onChange={(e) => setContacto({ address: e.target.value })} />
          </label>
        </div>
        <label className="block text-sm">
          Dirección de tu web, si está en tu propio alojamiento (por ejemplo https://fontaneriasuarez.es)
          <input
            className="input mt-1 w-full"
            type="url"
            maxLength={200}
            placeholder="https://"
            value={content.urlPublica}
            onChange={(e) => update((d) => (d.urlPublica = e.target.value.trim()))}
          />
          <span className="text-xs text-kairikos-muted">
            Con ella preparamos lo que Google pide para leer bien tu web (el mapa del sitio y la dirección de cada página). Si la alojamos nosotros, no hace falta.
          </span>
        </label>
        <p className="text-xs text-kairikos-muted">Para el aviso legal y la política de privacidad de tu web (los pide la ley a toda web de un negocio).</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ['titular', 'Titular (tu nombre o el de la empresa)', 160],
              ['nif', 'NIF / CIF', 20],
              ['domicilio', 'Domicilio fiscal', 300],
              ['email', 'Correo de contacto', 160],
              ['registro', 'Datos registrales (solo sociedades)', 300],
            ] as const
          ).map(([key, label, max]) => (
            <label key={key} className="text-sm">
              {label}
              <input className="input mt-1 w-full" maxLength={max} value={content.legal[key]} onChange={(e) => update((d) => (d.legal[key] = e.target.value))} />
            </label>
          ))}
        </div>
      </div>
      ) : null}

    </>
  );

  const statusText =
    busy === 'save' ? (
      'Guardando…'
    ) : busy === 'foto' ? (
      'Subiendo la foto…'
    ) : busy === 'publish' ? (
      'Publicando…'
    ) : error ? (
      <span className="text-kairikos-danger">{error}</span>
    ) : dirty ? (
      <span className="font-medium text-kairikos-warning">Cambios sin guardar</span>
    ) : message ? (
      <span className="text-kairikos-success">{message}</span>
    ) : (
      <span className="text-kairikos-muted">Todo guardado</span>
    );

  // Cerrado: el resumen en la página, con el botón para abrir el editor.
  if (!abierto) {
    return (
      <section className="space-y-4" aria-label="Tu web" data-testid="site-content-editor">
        {statusCard}
        <div className="card flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="site-editor-summary">
          <p className="min-w-0 flex-1 basis-full text-sm sm:basis-auto" aria-live="polite">
            {statusText}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary" onClick={abrirEditor} data-testid="site-editor-open">
              Editar mi web
            </button>
            <button type="button" className="btn-ghost" disabled={busy !== null} onClick={openPreview}>
              Ver cómo queda
            </button>
            <button type="button" className="btn-ghost" disabled={busy !== null} onClick={publish}>
              Publicar
            </button>
          </div>
        </div>
      </section>
    );
  }

  // En el <body> y no aquí: algún antecesor de la página del portal crea su
  // propio marco para lo fijo, y el editor quedaba desplazado con una franja del
  // portal asomando por arriba.
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-kairikos-bg" role="dialog" aria-modal="true" aria-label="Editar tu web" data-testid="site-content-editor">
      <header className="flex items-center gap-2 border-b border-kairikos-border bg-kairikos-surface px-3 py-2">
        <button type="button" className="btn-ghost" onClick={cerrarEditor} data-testid="site-editor-close">
          ← Salir
        </button>
        <p className="min-w-0 truncate font-semibold">
          {props.operador ? `Web de ${props.operador.clienteNombre}` : 'Tu web'}
          {view.kind === 'pagina' ? <span className="font-normal text-kairikos-muted"> · {page.titulo}</span> : null}
        </p>
        {/* En pantalla grande, cómo se ve en cada aparato; en el móvil, cambiar
            entre editar y ver (no caben las dos cosas). */}
        <div className="ml-auto hidden gap-1 lg:flex" role="group" aria-label="Ver como">
          {(
            [
              ['ordenador', 'Ordenador'],
              ['movil', 'Móvil'],
            ] as const
          ).map(([key, label]) => (
            <button key={key} type="button" className={device === key ? 'btn-primary' : 'btn-ghost'} aria-pressed={device === key} onClick={() => setDevice(key)}>
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1 lg:hidden" role="group" aria-label="Editar o ver">
          <button type="button" className={!verMovil ? 'btn-primary' : 'btn-ghost'} aria-pressed={!verMovil} onClick={() => setVerMovil(false)}>
            Editar
          </button>
          <button type="button" className={verMovil ? 'btn-primary' : 'btn-ghost'} aria-pressed={verMovil} onClick={() => setVerMovil(true)} data-testid="site-editor-ver">
            Ver
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className={`${verMovil ? 'hidden' : 'flex'} w-full min-w-0 flex-col border-kairikos-border lg:flex lg:w-[480px] lg:shrink-0 lg:border-r`}>
          <div ref={panelRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {statusCard}
            {editorBody}
          </div>
      {/* La barra de abajo, siempre a la vista: qué pasa con tus cambios y los
          tres botones. Antes estaban solo arriba y no se veían al editar. */}
      <div className="border-t border-kairikos-border bg-kairikos-surface px-4 py-3" data-testid="site-editor-bar">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 basis-full text-sm sm:basis-auto" aria-live="polite">
            {statusText}
          </p>
          {/* Sin barra final en la ruta: Next.js la quita con una redirección
              que el navegador no siempre completa; las rutas relativas de la
              vista previa ya se reescriben enteras (hosted-site-paths.ts). */}
          <div className="flex w-full shrink-0 justify-end gap-2 sm:w-auto">
            {/* Deshacer y rehacer (también Ctrl+Z / Ctrl+Mayús+Z). */}
            <div className="mr-auto flex gap-1 sm:mr-0" role="group" aria-label="Historial de cambios">
              <button type="button" className="btn-ghost px-2" disabled={historySize.past === 0 || busy !== null} onClick={() => travel('deshacer')} title="Deshacer (Ctrl+Z)" aria-label="Deshacer" data-testid="site-editor-undo">
                <span aria-hidden="true">↶</span>
              </button>
              <button type="button" className="btn-ghost px-2" disabled={historySize.future === 0 || busy !== null} onClick={() => travel('rehacer')} title="Rehacer (Ctrl+Mayús+Z)" aria-label="Rehacer" data-testid="site-editor-redo">
                <span aria-hidden="true">↷</span>
              </button>
            </div>
            <button type="button" className="btn-ghost" disabled={busy !== null} onClick={openPreview}>
              Ver cómo queda
            </button>
            <button type="button" className="btn-ghost" disabled={!dirty || busy !== null} onClick={save}>
              Guardar
            </button>
            <button type="button" className="btn-primary" disabled={busy !== null} onClick={publish}>
              Publicar
            </button>
          </div>
        </div>
      </div>
        </div>
        <div className={`${verMovil ? 'flex' : 'hidden'} min-w-0 flex-1 flex-col lg:flex`}>
          <SiteLivePreview
            apiBase={props.apiBase}
            path={previewPath}
            body={previewBody}
            activeAnchor={view.kind === 'pagina' ? activo : null}
            device={pantallaPequena ? 'movil' : device}
            sectionIds={view.kind === 'pagina' ? page.secciones.map(anchorFor) : []}
            onPick={view.kind === 'pagina' ? pickFromPreview : undefined}
            onInlineChange={(ruta, value) => setValue(ruta, value)}
            maxFor={maxFor}
            onListAction={view.kind === 'pagina' ? listAction : undefined}
            onHistory={travel}
            onPhoto={view.kind === 'pagina' && busy === null ? pickPhoto : undefined}
          />
          <input
            ref={photoInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            data-testid="site-editor-photo-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void uploadPhoto(file);
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** La misma comprobación que parseVideoUrl (site-rich-blocks.ts), repetida
 *  aquí: es componente de cliente y no importa libs del servidor. */
function isVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.)/, '');
    if (host === 'youtu.be') return /^\/[A-Za-z0-9_-]{11}(\/|$)/.test(u.pathname);
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      return u.pathname === '/watch' ? /^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v') ?? '') : /^\/(embed|shorts|live)\/[A-Za-z0-9_-]{11}(\/|$)/.test(u.pathname);
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') return /^\/(video\/)?\d{6,12}(\/|$)/.test(u.pathname);
    return false;
  } catch {
    return false;
  }
}

const UPLOAD_ERRORS: Record<string, string> = {
  unreadable: 'No hemos podido leer esa imagen. Prueba con una JPG o PNG.',
  too_large: 'La imagen pesa demasiado incluso reducida. Prueba con otra.',
  not_an_image: 'Ese archivo no es una imagen JPG, PNG o WebP.',
  too_big_dimensions: 'La imagen es demasiado grande. Prueba con otra.',
  too_many_images: 'Has subido muchas imágenes sin usarlas. Guarda los cambios y vuelve a probar.',
  internal_error: 'No se ha podido subir. Inténtalo de nuevo en un momento.',
};

/**
 * Reduce la imagen en el navegador y la vuelve a codificar antes de subirla
 * (site-uploads.ts explica por qué aquí y no en el servidor). Al pintarla en
 * un canvas se pierden los datos de la cámara, GPS incluido. El logo guarda
 * la transparencia; las fotos van sobre blanco.
 */
async function prepareImage(file: File, kind: 'logo' | 'foto'): Promise<Blob> {
  const maxSide = kind === 'logo' ? 800 : 1920;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no_canvas');
  if (kind === 'foto') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string, quality?: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  // WebP si el navegador sabe hacerlo (Safari devuelve PNG en su lugar);
  // si no, PNG para el logo y JPEG para las fotos.
  const webp = await encode('image/webp', 0.82);
  if (webp && webp.type === 'image/webp') return webp;
  const fallback = kind === 'logo' ? await encode('image/png') : await encode('image/jpeg', 0.82);
  if (!fallback) throw new Error('no_blob');
  return fallback;
}

/** Reducir y subir una imagen: su ruta en la web, o el error para el cliente.
 *  La usan el selector del formulario y las fotos pulsadas en la vista. */
async function uploadImage(apiBase: string, file: File, kind: 'logo' | 'foto'): Promise<{ path: string } | { error: string }> {
  let blob: Blob;
  try {
    blob = await prepareImage(file, kind);
  } catch {
    return { error: UPLOAD_ERRORS.unreadable };
  }
  const form = new FormData();
  form.append('archivo', blob, `imagen.${blob.type.split('/')[1] ?? 'jpg'}`);
  const res = await fetch(`${apiBase}/images`, { method: 'POST', body: form }).catch(() => null);
  const body = (await res?.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!res?.ok || !body.path) return { error: UPLOAD_ERRORS[body.error ?? 'internal_error'] ?? UPLOAD_ERRORS.internal_error };
  return { path: body.path };
}

/** Subir, ver y quitar una imagen. La miniatura sale de la vista previa, que
 *  sirve la subida aunque todavía no esté guardada en el contenido. */
function ImagePicker({
  apiBase,
  label,
  help,
  value,
  kind,
  onChange,
}: {
  apiBase: string;
  label: string;
  help: string;
  value: string;
  kind: 'logo' | 'foto';
  onChange: (path: string) => void;
}) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  async function upload(file: File) {
    setState({ busy: true, error: null });
    const result = await uploadImage(apiBase, file, kind);
    if ('error' in result) {
      setState({ busy: false, error: result.error });
      return;
    }
    setState({ busy: false, error: null });
    onChange(result.path);
  }

  return (
    <div className="space-y-2" data-testid={`image-picker-${kind}`}>
      <p className="text-sm font-medium">{label}</p>
      <div
        className={`flex h-32 items-center justify-center overflow-hidden rounded-xl border border-kairikos-border ${kind === 'logo' ? 'bg-[repeating-conic-gradient(#eee_0_25%,#fff_0_50%)] bg-[length:16px_16px] p-3' : 'bg-kairikos-surface'}`}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value.startsWith('/') ? value : `${apiBase}/preview/${value}`} alt={label} className={kind === 'logo' ? 'max-h-full max-w-full object-contain' : 'h-full w-full object-cover'} />
        ) : (
          <span className="px-3 text-center text-xs text-kairikos-muted">{help}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className={`btn-ghost text-sm ${state.busy ? 'pointer-events-none opacity-60' : 'cursor-pointer'}`}>
          {state.busy ? 'Subiendo…' : value ? 'Cambiar' : 'Subir'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={state.busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void upload(file);
            }}
          />
        </label>
        {value ? (
          <button type="button" className="btn-ghost text-sm text-kairikos-danger" disabled={state.busy} onClick={() => onChange('')}>
            Quitar
          </button>
        ) : null}
      </div>
      {state.error ? <p className="text-sm text-kairikos-danger">{state.error}</p> : null}
    </div>
  );
}

/** Las fotos de una galería (hasta 24) o las dos de un antes y después. */
function RichPhotosEditor({
  apiBase,
  mode,
  fotos,
  onChange,
}: {
  apiBase: string;
  mode: 'galeria' | 'antes_despues' | 'marcas';
  fotos: SiteBlock['fotos'];
  onChange: (fotos: SiteBlock['fotos']) => void;
}) {
  const list = mode === 'antes_despues' ? [0, 1].map((i) => fotos[i] ?? { foto: '', alt: '', texto: i === 0 ? 'Antes' : 'Después' }) : fotos;
  const set = (i: number, patch: Partial<SiteBlock['fotos'][number]>) => onChange(list.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, d: number) => {
    const next = [...list];
    if (i + d < 0 || i + d >= next.length) return;
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {mode === 'antes_despues' ? (
        <p className="text-xs text-kairikos-muted">Dos fotos del mismo sitio, a ser posible desde el mismo ángulo. En tu web se superponen y el visitante arrastra para comparar.</p>
      ) : mode === 'marcas' ? (
        <p className="text-xs text-kairikos-muted">Los logos de las marcas con las que trabajas o de tus certificados, mejor en PNG con fondo transparente. Con más de cuatro, en tu web pasan en cinta.</p>
      ) : (
        <p className="text-xs text-kairikos-muted">Tus trabajos. En tu web, al tocar una foto se amplía y se puede pasar a la siguiente.</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {list.map((f, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-kairikos-border p-3">
            <ImagePicker
              apiBase={apiBase}
              label={mode === 'antes_despues' ? (i === 0 ? 'Foto de antes' : 'Foto de después') : mode === 'marcas' ? `Logo ${i + 1}` : `Foto ${i + 1}`}
              help={mode === 'marcas' ? 'Sube el logo.' : 'Sube una foto tuya.'}
              value={f.foto}
              kind={mode === 'marcas' ? 'logo' : 'foto'}
              onChange={(path) => set(i, { foto: path })}
            />
            <label className="block text-xs font-medium">
              {mode === 'antes_despues' ? 'Etiqueta (sale sobre la foto)' : mode === 'marcas' ? 'Texto bajo el logo (opcional, p. ej. «Instalador oficial»)' : 'Pie de foto (opcional)'}
              <input className="input mt-1 w-full" maxLength={160} value={f.texto} onChange={(e) => set(i, { texto: e.target.value })} />
            </label>
            <label className="block text-xs font-medium">
              {mode === 'marcas' ? 'Nombre de la marca o del certificado' : 'Qué se ve (para quien no puede verla y para Google)'}
              <input className="input mt-1 w-full" maxLength={160} value={f.alt} onChange={(e) => set(i, { alt: e.target.value })} />
            </label>
            {mode !== 'antes_despues' ? (
              <div className="flex gap-2">
                <button type="button" className="btn-ghost text-xs" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Subir">↑</button>
                <button type="button" className="btn-ghost text-xs" onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label="Bajar">↓</button>
                <button type="button" className="btn-ghost text-xs text-kairikos-danger" onClick={() => onChange(list.filter((_, j) => j !== i))}>
                  Quitar
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {mode !== 'antes_despues' && list.length < 24 ? (
        <button type="button" className="btn-ghost text-sm" onClick={() => onChange([...list, { foto: '', alt: '', texto: '' }])}>
          {mode === 'marcas' ? '+ Añadir logo' : '+ Añadir foto'}
        </button>
      ) : null}
    </div>
  );
}

/** Tanda 2 — las pestañas de un bloque (hasta 6). */
function TabsEditor({ apiBase, pestanas, onChange }: { apiBase: string; pestanas: SiteBlock['pestanas']; onChange: (p: SiteBlock['pestanas']) => void }) {
  const set = (i: number, patch: Partial<SiteBlock['pestanas'][number]>) => onChange(pestanas.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <div className="space-y-3">
      <p className="text-xs text-kairikos-muted">Varias pestañas en un mismo bloque, por ejemplo «Particulares · Empresas · Comunidades». El visitante pasa de una a otra sin bajar.</p>
      {pestanas.map((t, i) => (
        <div key={i} className="grid gap-3 rounded-lg border border-kairikos-border p-3 sm:grid-cols-[1fr_14rem]">
          <div className="space-y-2">
            <label className="block text-xs font-medium">
              Título de la pestaña
              <input className="input mt-1 w-full" maxLength={40} value={t.titulo} onChange={(e) => set(i, { titulo: e.target.value })} />
            </label>
            <label className="block text-xs font-medium">
              Texto (puedes usar **negrita** y listas con «- »)
              <textarea className="input mt-1 w-full" rows={4} maxLength={2000} value={t.texto} onChange={(e) => set(i, { texto: e.target.value })} />
            </label>
            <button type="button" className="btn-ghost text-xs text-kairikos-danger" onClick={() => onChange(pestanas.filter((_, j) => j !== i))}>
              Quitar pestaña
            </button>
          </div>
          <div className="space-y-2">
            <ImagePicker apiBase={apiBase} label="Foto (opcional)" help="Una foto para esta pestaña." value={t.foto} kind="foto" onChange={(path) => set(i, { foto: path })} />
            {t.foto ? (
              <label className="block text-xs font-medium">
                Qué se ve
                <input className="input mt-1 w-full" maxLength={160} value={t.alt} onChange={(e) => set(i, { alt: e.target.value })} />
              </label>
            ) : null}
          </div>
        </div>
      ))}
      {pestanas.length < 6 ? (
        <button type="button" className="btn-ghost text-sm" onClick={() => onChange([...pestanas, { titulo: '', texto: '', foto: '', alt: '' }])}>
          + Añadir pestaña
        </button>
      ) : null}
    </div>
  );
}

/** Tanda 2 — una comparativa: hasta 4 columnas y 15 filas. */
function ComparisonEditor({ value, onChange }: { value: SiteBlock['comparativa']; onChange: (v: SiteBlock['comparativa']) => void }) {
  const { columnas, destacada, filas } = value;
  const setCol = (i: number, t: string) => onChange({ ...value, columnas: columnas.map((c, j) => (j === i ? t : c)) });
  const addCol = () => onChange({ ...value, columnas: [...columnas, ''], filas: filas.map((f) => ({ ...f, valores: [...f.valores, ''] })) });
  const removeCol = (i: number) =>
    onChange({
      columnas: columnas.filter((_, j) => j !== i),
      destacada: destacada === i ? -1 : destacada > i ? destacada - 1 : destacada,
      filas: filas.map((f) => ({ ...f, valores: f.valores.filter((_, j) => j !== i) })),
    });
  const setFila = (i: number, patch: Partial<SiteBlock['comparativa']['filas'][number]>) => onChange({ ...value, filas: filas.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  return (
    <div className="space-y-3">
      <p className="text-xs text-kairikos-muted">Compara opciones (PVC frente a aluminio, tus kits o tus planes). Escribe «sí» o «no» y en tu web sale una marca; cualquier otra cosa sale tal cual.</p>
      <div className="flex flex-wrap items-end gap-2">
        {columnas.map((c, i) => (
          <label key={i} className="block text-xs font-medium">
            Opción {i + 1}
            <span className="mt-1 flex gap-1">
              <input className="input w-36" maxLength={40} value={c} onChange={(e) => setCol(i, e.target.value)} />
              <button type="button" className="btn-ghost text-xs text-kairikos-danger" onClick={() => removeCol(i)} aria-label={`Quitar la opción ${i + 1}`}>
                ×
              </button>
            </span>
          </label>
        ))}
        {columnas.length < 4 ? (
          <button type="button" className="btn-ghost text-sm" onClick={addCol}>
            + Opción
          </button>
        ) : null}
      </div>
      {columnas.length ? (
        <label className="block text-xs font-medium">
          Resaltar una opción
          <select className="input mt-1" value={destacada} onChange={(e) => onChange({ ...value, destacada: Number(e.target.value) })}>
            <option value={-1}>Ninguna</option>
            {columnas.map((c, i) => (
              <option key={i} value={i}>
                {c || `Opción ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {filas.map((f, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg border border-kairikos-border p-2">
          <label className="block flex-1 text-xs font-medium">
            Qué se compara
            <input className="input mt-1 w-full" maxLength={120} value={f.concepto} onChange={(e) => setFila(i, { concepto: e.target.value })} />
          </label>
          {columnas.map((c, j) => (
            <label key={j} className="block text-xs font-medium">
              {c || `Opción ${j + 1}`}
              <input
                className="input mt-1 w-28"
                maxLength={60}
                placeholder="sí / no / texto"
                value={f.valores[j] ?? ''}
                onChange={(e) => setFila(i, { valores: columnas.map((_, k) => (k === j ? e.target.value : (f.valores[k] ?? ''))) })}
              />
            </label>
          ))}
          <button type="button" className="btn-ghost text-xs text-kairikos-danger" onClick={() => onChange({ ...value, filas: filas.filter((_, j) => j !== i) })}>
            Quitar
          </button>
        </div>
      ))}
      {filas.length < 15 ? (
        <button type="button" className="btn-ghost text-sm" onClick={() => onChange({ ...value, filas: [...filas, { concepto: '', valores: columnas.map(() => '') }] })}>
          + Añadir fila
        </button>
      ) : null}
    </div>
  );
}

/** Tanda 2 — los hitos de una trayectoria (hasta 12). */
function MilestonesEditor({ hitos, onChange }: { hitos: SiteBlock['hitos']; onChange: (h: SiteBlock['hitos']) => void }) {
  const set = (i: number, patch: Partial<SiteBlock['hitos'][number]>) => onChange(hitos.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  return (
    <div className="space-y-3">
      <p className="text-xs text-kairikos-muted">Tu historia en fechas: cuándo empezaste, la primera nave, los 1.000 clientes… En tu web sale como una línea de tiempo.</p>
      {hitos.map((h, i) => (
        <div key={i} className="grid gap-2 rounded-lg border border-kairikos-border p-3 sm:grid-cols-[8rem_1fr]">
          <label className="block text-xs font-medium">
            Fecha
            <input className="input mt-1 w-full" maxLength={30} placeholder="1998" value={h.fecha} onChange={(e) => set(i, { fecha: e.target.value })} />
          </label>
          <label className="block text-xs font-medium">
            Qué pasó
            <input className="input mt-1 w-full" maxLength={90} value={h.titulo} onChange={(e) => set(i, { titulo: e.target.value })} />
          </label>
          <label className="block text-xs font-medium sm:col-span-2">
            Detalle (opcional)
            <textarea className="input mt-1 w-full" rows={2} maxLength={300} value={h.texto} onChange={(e) => set(i, { texto: e.target.value })} />
          </label>
          <button type="button" className="btn-ghost justify-self-start text-xs text-kairikos-danger" onClick={() => onChange(hitos.filter((_, j) => j !== i))}>
            Quitar
          </button>
        </div>
      ))}
      {hitos.length < 12 ? (
        <button type="button" className="btn-ghost text-sm" onClick={() => onChange([...hitos, { fecha: '', titulo: '', texto: '' }])}>
          + Añadir hito
        </button>
      ) : null}
    </div>
  );
}

/** Los modelos de un catálogo (hasta 24). Con dos categorías o más, la web
 *  enseña filtros. */
function CatalogEditor({ apiBase, productos, onChange }: { apiBase: string; productos: SiteBlock['productos']; onChange: (p: SiteBlock['productos']) => void }) {
  const set = (i: number, patch: Partial<SiteBlock['productos'][number]>) => onChange(productos.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const move = (i: number, d: number) => {
    const next = [...productos];
    if (i + d < 0 || i + d >= next.length) return;
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-kairikos-muted">Tus modelos o productos. Si les pones categoría (Ventanas, Puertas, Mamparas…), tu web enseña unos botones para filtrar.</p>
      {productos.map((p, i) => (
        <div key={i} className="grid gap-3 rounded-lg border border-kairikos-border p-3 sm:grid-cols-[14rem_1fr]">
          <ImagePicker apiBase={apiBase} label="Foto" help="Una foto del modelo." value={p.foto} kind="foto" onChange={(path) => set(i, { foto: path })} />
          <div className="space-y-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-xs font-medium">
                Nombre
                <input className="input mt-1 w-full" maxLength={80} value={p.nombre} onChange={(e) => set(i, { nombre: e.target.value })} />
              </label>
              <label className="block text-xs font-medium">
                Categoría (opcional)
                <input className="input mt-1 w-full" maxLength={40} value={p.categoria} onChange={(e) => set(i, { categoria: e.target.value })} />
              </label>
            </div>
            <label className="block text-xs font-medium">
              Descripción
              <textarea className="input mt-1 w-full" rows={2} maxLength={300} value={p.descripcion} onChange={(e) => set(i, { descripcion: e.target.value })} />
            </label>
            <label className="block text-xs font-medium">
              Características (una por línea, hasta 8)
              <textarea
                className="input mt-1 w-full"
                rows={3}
                value={p.caracteristicas.join('\n')}
                onChange={(e) => set(i, { caracteristicas: e.target.value.split('\n').map((c) => c.slice(0, 80)).slice(0, 8) })}
                onBlur={(e) => set(i, { caracteristicas: e.target.value.split('\n').map((c) => c.trim()).filter(Boolean).slice(0, 8) })}
              />
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-xs font-medium">
                Precio (opcional, p. ej. «desde 450 €»)
                <input className="input mt-1 w-full" maxLength={40} value={p.precio} onChange={(e) => set(i, { precio: e.target.value })} />
              </label>
              <label className="block text-xs font-medium">
                Qué se ve en la foto
                <input className="input mt-1 w-full" maxLength={160} value={p.alt} onChange={(e) => set(i, { alt: e.target.value })} />
              </label>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn-ghost text-xs" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Subir">↑</button>
              <button type="button" className="btn-ghost text-xs" onClick={() => move(i, 1)} disabled={i === productos.length - 1} aria-label="Bajar">↓</button>
              <button type="button" className="btn-ghost text-xs text-kairikos-danger" onClick={() => onChange(productos.filter((_, j) => j !== i))}>
                Quitar
              </button>
            </div>
          </div>
        </div>
      ))}
      {productos.length < 24 ? (
        <button
          type="button"
          className="btn-ghost text-sm"
          onClick={() => onChange([...productos, { nombre: '', categoria: '', foto: '', alt: '', descripcion: '', caracteristicas: [], precio: '' }])}
        >
          + Añadir modelo
        </button>
      ) : null}
    </div>
  );
}

/** El color de la marca y la pareja de letras. Vacío = lo de la plantilla. */
function StyleCard({
  estilo,
  value,
  onChange,
}: {
  estilo: NonNullable<SiteContentEditorProps['estilo']>;
  value: SiteContent['estilo'];
  onChange: (patch: { acento?: string; tipografia?: string }) => void;
}) {
  const own = estilo.muestras[0]?.color ?? '#000000';
  const acento = value?.acento || '';
  const tipografia = value?.tipografia || '';
  const custom = acento !== '' && !estilo.muestras.some((m) => m.color === acento);
  return (
    <div className="card space-y-4" data-testid="site-editor-style">
      <div>
        <p className="font-semibold">Color y letra</p>
        <p className="text-sm text-kairikos-muted">
          Pon el color de tu marca (el de tu rótulo, tu furgoneta o tu logo) y el tipo de letra que más te guste. Si tu color no se leyera bien
          sobre el fondo de tu web, lo aclaramos u oscurecemos lo justo.
        </p>
      </div>
      {estilo.muestras.length ? (
        <fieldset>
          <legend className="text-sm font-medium">Color</legend>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {estilo.muestras.map((m, i) => {
              const active = i === 0 ? acento === '' || acento === m.color : acento === m.color;
              return (
                <button
                  key={m.color}
                  type="button"
                  className={active ? 'btn-primary text-sm' : 'btn-ghost text-sm'}
                  aria-pressed={active}
                  onClick={() => onChange({ acento: i === 0 ? '' : m.color })}
                >
                  <span aria-hidden="true" className="mr-1 inline-block h-4 w-4 rounded-full border border-black/20 align-middle" style={{ background: m.color }} />
                  {m.nombre}
                  {i === 0 ? ' (el de la plantilla)' : ''}
                </button>
              );
            })}
            <label className={custom ? 'btn-primary text-sm' : 'btn-ghost text-sm'}>
              Otro color
              <input
                type="color"
                className="ml-2 h-6 w-8 cursor-pointer border-0 bg-transparent p-0 align-middle"
                value={acento || own}
                onChange={(e) => onChange({ acento: e.target.value.toLowerCase() })}
              />
            </label>
          </div>
        </fieldset>
      ) : null}
      {estilo.parejas.length ? (
        <fieldset>
          <legend className="text-sm font-medium">Letra</legend>
          {/* Las hojas de cada pareja, servidas por el portal, para que cada
              opción se vea con su propia letra. */}
          {estilo.parejas.flatMap((p) => p.hojas).map((href) => (
            <link key={href} rel="stylesheet" href={href} />
          ))}
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {estilo.parejas.map((p, i) => {
              const active = i === 0 ? tipografia === '' || tipografia === p.id : tipografia === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`rounded-xl border p-3 text-left ${active ? 'border-kairikos-accent ring-2 ring-kairikos-accent' : 'border-kairikos-border'}`}
                  aria-pressed={active}
                  onClick={() => onChange({ tipografia: i === 0 ? '' : p.id })}
                >
                  <span className="block text-xl font-bold" style={{ fontFamily: `"${p.titulares}"` }}>
                    {p.nombre}
                  </span>
                  <span className="block text-sm" style={{ fontFamily: `"${p.texto}"` }}>
                    Así se lee el texto de tu web.
                  </span>
                  <span className="mt-1 block text-xs text-kairikos-muted">
                    {p.titulares} + {p.texto}
                    {i === 0 ? ' · la de la plantilla' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      <p className="text-xs text-kairikos-muted">Pulsa «Ver cómo queda» (abajo) para verlo en tu web.</p>
    </div>
  );
}

function FieldInput({
  ruta,
  field,
  value,
  example,
  iconIds,
  icons,
  onChange,
}: {
  /** La ruta del dato: la vista la usa para llevar al cliente a este campo. */
  ruta?: string;
  field: Field;
  value: string;
  example: boolean;
  iconIds: string[];
  icons?: IconSymbol[];
  onChange: (v: string) => void;
}) {
  const cls = `input mt-1 w-full ${example ? 'border-kairikos-warning bg-kairikos-warning/10' : ''}`;
  if (field.kind === 'icon' && icons?.length) return <IconPicker label={field.label} value={value} icons={icons} onChange={onChange} />;
  return (
    <label className="block text-sm">
      {field.label}
      {example ? <span className="ml-2 pill-warning">ejemplo</span> : null}
      {field.kind === 'textarea' ? (
        <textarea className={cls} data-ruta={ruta} rows={3} maxLength={field.max} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : field.kind === 'icon' ? (
        <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Por defecto</option>
          {iconIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      ) : (
        <input className={cls} data-ruta={ruta} maxLength={field.max} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

/** «herramienta» → «Herramienta», «flecha-derecha» → «Flecha derecha»: el
 *  nombre del icono, para leerlo en voz alta y en el aviso al pasar. */
function iconName(id: string): string {
  const s = id.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Elegir un icono viéndolo: una rejilla con los dibujos de la plantilla. */
function IconPicker({ label, value, icons, onChange }: { label: string; value: string; icons: IconSymbol[]; onChange: (v: string) => void }) {
  return (
    <fieldset className="text-sm">
      <legend>{label}</legend>
      <div className="mt-1 flex flex-wrap gap-1" role="radiogroup" aria-label={label}>
        <button
          type="button"
          role="radio"
          aria-checked={value === ''}
          className={`flex h-10 items-center rounded-lg border px-2 text-xs ${value === '' ? 'border-kairikos-accent ring-2 ring-kairikos-accent' : 'border-kairikos-border'}`}
          onClick={() => onChange('')}
        >
          Por defecto
        </button>
        {icons.map((icon) => (
          <button
            key={icon.id}
            type="button"
            role="radio"
            aria-checked={value === icon.id}
            aria-label={iconName(icon.id)}
            title={iconName(icon.id)}
            className={`flex h-10 w-10 items-center justify-center rounded-lg border ${value === icon.id ? 'border-kairikos-accent ring-2 ring-kairikos-accent' : 'border-kairikos-border'}`}
            onClick={() => onChange(icon.id)}
          >
            {/* Saneado en el servidor (site-icon-symbols.ts): solo formas de SVG. */}
            <svg viewBox={icon.viewBox} width="22" height="22" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon.body }} />
          </button>
        ))}
      </div>
    </fieldset>
  );
}

// Listas anidadas por ruta ('precios.filas', 'bloques.historia.items').
function listAt(d: SiteContent, path: string): unknown[] {
  const parts = path.split('.');
  let target: unknown = parts[0] === 'bloques' ? d.bloques.find((b) => b.id === parts[1]) : d.datos;
  for (const p of parts[0] === 'bloques' ? parts.slice(2) : parts) target = target == null ? undefined : (target as Record<string, unknown>)[p];
  return target as unknown[];
}

/** Mete un elemento en la posición `index`; las marcas de ejemplo de los de
 *  detrás se corren una posición (van por posición, como en removeIn). */
function insertIn(d: SiteContent, path: string, index: number, item: unknown) {
  listAt(d, path).splice(index, 0, item);
  d.ejemplos = d.ejemplos.map((e) => {
    const m = e.startsWith(`${path}.`) ? e.slice(path.length + 1).match(/^(\d+)(.*)$/) : null;
    return m && Number(m[1]) >= index ? `${path}.${Number(m[1]) + 1}${m[2]}` : e;
  });
}

function removeIn(d: SiteContent, path: string, index: number) {
  listAt(d, path).splice(index, 1);
  // Las marcas de ejemplo van por posición: se recolocan las de detrás.
  d.ejemplos = d.ejemplos
    .filter((e) => !e.startsWith(`${path}.${index}.`) && e !== `${path}.${index}`)
    .map((e) => {
      const m = e.startsWith(`${path}.`) ? e.slice(path.length + 1).match(/^(\d+)(.*)$/) : null;
      return m && Number(m[1]) > index ? `${path}.${Number(m[1]) - 1}${m[2]}` : e;
    });
}

function swapIn(d: SiteContent, path: string, a: number, b: number) {
  const list = listAt(d, path);
  if (b < 0 || b >= list.length) return;
  [list[a], list[b]] = [list[b], list[a]];
  d.ejemplos = d.ejemplos.map((e) => {
    if (!e.startsWith(`${path}.`)) return e;
    const m = e.slice(path.length + 1).match(/^(\d+)(.*)$/);
    if (!m) return e;
    const i = Number(m[1]);
    return i === a ? `${path}.${b}${m[2]}` : i === b ? `${path}.${a}${m[2]}` : e;
  });
}
