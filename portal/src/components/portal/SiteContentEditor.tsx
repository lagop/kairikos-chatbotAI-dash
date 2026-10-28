'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SiteBlock, SiteBlogEntry, SiteContent, SiteSectionRef, SiteSectionType } from '@/lib/site-content';

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

export interface SiteContentEditorProps {
  clientProductId: string;
  initialContent: SiteContent;
  phone: string | null;
  address: string | null;
  status: string;
  lastPublishedAt: string | null;
  iconIds: string[];
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

  const pageIndex = view.kind === 'pagina' ? Math.min(view.index, content.paginas.length - 1) : 0;
  const page = content.paginas[pageIndex];
  const pending = content.ejemplos.length;
  // La vista previa abre la página que se está editando. La del blog solo
  // existe con alguna entrada publicada.
  const previewPath = view.kind === 'blog' ? (content.blog.entradas.some((e) => e.publicada) ? '/blog' : '') : page.ruta ? `/${page.ruta}` : '';
  const legalMissing = (['titular', 'nif', 'domicilio', 'email'] as const).filter((k) => !content.legal[k].trim());

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

  function update(mutate: (draft: SiteContent) => void) {
    setContent((prev) => {
      const next = structuredClone(prev);
      mutate(next);
      return next;
    });
    setDirty(true);
    setMessage(null);
  }

  /** Cambia un dato y, si era de ejemplo, deja de serlo: lo ha escrito él. */
  function setValue(path: string, value: string) {
    update((d) => {
      const parts = path.split('.');
      let target: Record<string, unknown> | unknown[] = parts[0] === 'bloques' ? (d.bloques.find((b) => b.id === parts[1]) as unknown as Record<string, unknown>) : (d.datos as unknown as Record<string, unknown>);
      const rest = parts[0] === 'bloques' ? parts.slice(2) : parts;
      for (const p of rest.slice(0, -1)) target = (target as Record<string, unknown>)[p] as Record<string, unknown>;
      (target as Record<string, unknown>)[rest[rest.length - 1]] = value;
      d.ejemplos = d.ejemplos.filter((e) => e !== path);
    });
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
      d.bloques.push({ id, tipo: newBlock, titulo: '', texto: '', foto: '', fotoAlt: '', items: newBlock === 'lista' ? [{ texto: '', icono: '' }] : [] });
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
    const res = await fetch(`/api/portal/website/${props.clientProductId}/content`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, phone: phone || null, address: address || null, baseUpdatedAt }),
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
    setDirty(false);
    setMessage('Guardado. Tu web publicada no cambia hasta que pulses «Publicar».');
    return true;
  }

  async function publish() {
    if (dirty && !(await save())) return;
    setBusy('publish');
    setError(null);
    const res = await fetch(`/api/portal/website/${props.clientProductId}/publish`, { method: 'POST' });
    setBusy(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(ERRORS[body.error ?? 'publish_failed'] ?? ERRORS.publish_failed);
      return;
    }
    setMessage('Publicada. Los cambios ya están en tu web.');
    router.refresh();
  }

  const listEditor = (path: string, items: Record<string, string>[], fields: Field[], empty: Record<string, string>, max: number) => (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="rounded-lg border border-kairikos-border p-3 space-y-2">
          {fields.map((f) => (
            <FieldInput key={f.key} field={f} value={item[f.key] ?? ''} iconIds={props.iconIds} example={content.ejemplos.includes(`${path}.${i}.${f.key}`)} onChange={(v) => setValue(`${path}.${i}.${f.key}`, v)} />
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
      <FieldInput field={{ key: path, label, kind, max }} value={value} iconIds={props.iconIds} example={content.ejemplos.includes(path)} onChange={(v) => setValue(path, v)} />
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
                clientProductId={props.clientProductId}
                label="Foto"
                help="Una foto tuya: un trabajo, tu equipo, tu local."
                value={b.foto}
                kind="foto"
                onChange={(path) => update((d) => void ((d.bloques.find((x) => x.id === b.id) as SiteBlock).foto = path))}
              />
              {text('Qué se ve en la foto (para quien no puede verla y para Google)', `${base}.fotoAlt`, b.fotoAlt, 160)}
            </>
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

  return (
    <section className="space-y-4" aria-label="Tu web" data-testid="site-content-editor">
      <div className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">Tu web</p>
          <span className={props.status === 'published' ? 'pill-success' : 'pill-muted'}>{props.status === 'published' ? 'Publicada' : 'Sin publicar'}</span>
          {props.lastPublishedAt ? <span className="text-xs text-kairikos-muted">Última publicación: {new Date(props.lastPublishedAt).toLocaleString('es-ES')}</span> : null}
        </div>
        {pending > 0 ? (
          <p className="text-sm text-kairikos-warning" data-testid="site-editor-pending">
            Quedan {pending} datos de ejemplo por revisar en: {pendingSections.join(', ')}. Cámbialos por los tuyos o confirma cada sección.
          </p>
        ) : null}
        {legalMissing.length ? <p className="text-sm text-kairikos-warning">Faltan tus datos legales (abajo del todo): sin ellos no se puede publicar.</p> : null}
        <div className="flex flex-wrap gap-2">
          {/* Sin barra final: Next.js la quita con una redirección que el
              navegador no siempre completa; las rutas relativas de la vista
              previa ya se reescriben enteras (hosted-site-paths.ts). */}
          <a className="btn-ghost" href={`/api/portal/website/${props.clientProductId}/preview${previewPath}`} target="_blank" rel="noopener">
            Ver cómo queda
          </a>
          <button type="button" className="btn-ghost" disabled={!dirty || busy !== null} onClick={save}>
            {busy === 'save' ? 'Guardando…' : 'Guardar'}
          </button>
          <button type="button" className="btn-primary" disabled={busy !== null} onClick={publish}>
            {busy === 'publish' ? 'Publicando…' : 'Publicar'}
          </button>
        </div>
        {message ? <p className="text-sm text-kairikos-success">{message}</p> : null}
        {error ? <p className="text-sm text-kairikos-danger">{error}</p> : null}
      </div>

      {props.estilo ? <StyleCard estilo={props.estilo} value={content.estilo} onChange={setStyle} /> : null}

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
            clientProductId={props.clientProductId}
            label="Logo"
            help="Mejor en PNG con fondo transparente."
            value={content.imagenes?.logo ?? ''}
            kind="logo"
            onChange={(path) => update((d) => void (d.imagenes = { logo: path, portada: d.imagenes?.portada ?? '' }))}
          />
          <ImagePicker
            clientProductId={props.clientProductId}
            label="Foto de portada"
            help="Horizontal, de un trabajo tuyo. Sin ella, va la de muestra de tu oficio."
            value={content.imagenes?.portada ?? ''}
            kind="foto"
            onChange={(path) => update((d) => void (d.imagenes = { logo: d.imagenes?.logo ?? '', portada: path }))}
          />
        </div>
      </div>

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
                <li key={refKey(ref)} className={`card ${ref.oculta ? 'opacity-60' : ''}`}>
                  <details>
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

      <div className="card space-y-3">
        <p className="font-semibold">Contacto y datos legales</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Teléfono
            <input className="input mt-1 w-full" maxLength={50} value={phone} onChange={(e) => { setPhone(e.target.value); setDirty(true); }} />
          </label>
          <label className="text-sm">
            Dirección
            <input className="input mt-1 w-full" maxLength={300} value={address} onChange={(e) => { setAddress(e.target.value); setDirty(true); }} />
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
    </section>
  );
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

/** Subir, ver y quitar una imagen. La miniatura sale de la vista previa, que
 *  sirve la subida aunque todavía no esté guardada en el contenido. */
function ImagePicker({
  clientProductId,
  label,
  help,
  value,
  kind,
  onChange,
}: {
  clientProductId: string;
  label: string;
  help: string;
  value: string;
  kind: 'logo' | 'foto';
  onChange: (path: string) => void;
}) {
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  async function upload(file: File) {
    setState({ busy: true, error: null });
    let blob: Blob;
    try {
      blob = await prepareImage(file, kind);
    } catch {
      setState({ busy: false, error: UPLOAD_ERRORS.unreadable });
      return;
    }
    const form = new FormData();
    form.append('archivo', blob, `imagen.${blob.type.split('/')[1] ?? 'jpg'}`);
    const res = await fetch(`/api/portal/website/${clientProductId}/images`, { method: 'POST', body: form }).catch(() => null);
    const body = (await res?.json().catch(() => ({}))) as { path?: string; error?: string };
    if (!res?.ok || !body.path) {
      setState({ busy: false, error: UPLOAD_ERRORS[body.error ?? 'internal_error'] ?? UPLOAD_ERRORS.internal_error });
      return;
    }
    setState({ busy: false, error: null });
    onChange(body.path);
  }

  return (
    <div className="space-y-2" data-testid={`image-picker-${kind}`}>
      <p className="text-sm font-medium">{label}</p>
      <div
        className={`flex h-32 items-center justify-center overflow-hidden rounded-xl border border-kairikos-border ${kind === 'logo' ? 'bg-[repeating-conic-gradient(#eee_0_25%,#fff_0_50%)] bg-[length:16px_16px] p-3' : 'bg-kairikos-surface'}`}
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/portal/website/${clientProductId}/preview/${value}`} alt={label} className={kind === 'logo' ? 'max-h-full max-w-full object-contain' : 'h-full w-full object-cover'} />
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
      <p className="text-xs text-kairikos-muted">Guarda y pulsa «Ver cómo queda» para verlo en tu web.</p>
    </div>
  );
}

function FieldInput({ field, value, example, iconIds, onChange }: { field: Field; value: string; example: boolean; iconIds: string[]; onChange: (v: string) => void }) {
  const cls = `input mt-1 w-full ${example ? 'border-kairikos-warning bg-kairikos-warning/10' : ''}`;
  return (
    <label className="block text-sm">
      {field.label}
      {example ? <span className="ml-2 pill-warning">ejemplo</span> : null}
      {field.kind === 'textarea' ? (
        <textarea className={cls} rows={3} maxLength={field.max} value={value} onChange={(e) => onChange(e.target.value)} />
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
        <input className={cls} maxLength={field.max} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

// Listas anidadas por ruta ('precios.filas', 'bloques.historia.items').
function listAt(d: SiteContent, path: string): unknown[] {
  const parts = path.split('.');
  let target: unknown = parts[0] === 'bloques' ? d.bloques.find((b) => b.id === parts[1]) : d.datos;
  for (const p of parts[0] === 'bloques' ? parts.slice(2) : parts) target = (target as Record<string, unknown>)[p];
  return target as unknown[];
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
