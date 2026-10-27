'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SiteBlock, SiteContent, SiteSectionRef, SiteSectionType } from '@/lib/site-content';

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
// Este archivo no importa nada de lib/ que no sean tipos: es un componente de
// cliente (ver «Rutas y libs» en CLAUDE.md).
// =============================================================================

export interface SiteContentEditorProps {
  clientProductId: string;
  initialContent: SiteContent;
  phone: string | null;
  address: string | null;
  status: string;
  lastPublishedAt: string | null;
  iconIds: string[];
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

  const page = content.paginas[0];
  const pending = content.ejemplos.length;
  const legalMissing = (['titular', 'nif', 'domicilio', 'email'] as const).filter((k) => !content.legal[k].trim());

  const pendingSections = useMemo(
    () => page.secciones.filter((r) => !r.oculta && pendingIn(content, r) > 0).map((r) => (r.tipo === 'bloque' ? 'un bloque' : SECTION_LABEL[r.tipo])),
    [content, page],
  );

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

  function confirmSection(ref: SiteSectionRef) {
    const prefixes = pathsFor(ref);
    update((d) => {
      d.ejemplos = d.ejemplos.filter((e) => !prefixes.some((p) => e === p || e.startsWith(`${p}.`)));
      if (!d.seccionesConfirmadas.includes(refKey(ref))) d.seccionesConfirmadas.push(refKey(ref));
    });
  }

  function move(index: number, delta: number) {
    update((d) => {
      const list = d.paginas[0].secciones;
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
      const list = d.paginas[0].secciones;
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
      body: JSON.stringify({ content, phone: phone || null, address: address || null }),
    });
    setBusy(null);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(ERRORS[body.error ?? 'internal_error'] ?? ERRORS.internal_error);
      return false;
    }
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
          {b.tipo === 'texto_foto' ? <p className="text-xs text-kairikos-muted">Para poner tu foto, mándanosla por soporte y la subimos nosotros.</p> : null}
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
          <a className="btn-ghost" href={`/api/portal/website/${props.clientProductId}/preview`} target="_blank" rel="noopener">
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
                      <button type="button" className="btn-ghost" onClick={() => update((d) => (d.paginas[0].secciones[i].oculta = !ref.oculta))}>
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
        <span className="text-sm">Añadir</span>
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
        <span className="text-xs text-kairikos-muted">Se añade antes de «Contacto»; luego puedes moverlo.</span>
      </div>

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
