'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CHECK_SAMPLES, checkPlan, runSiteChecks, type CheckPlanItem, type CheckRun, type CheckStyle } from '@/lib/site-template-checks';
import type { TemplateDiffPart } from '@/lib/site-template-diff';

// =============================================================================
// Webs con IA, entrega 2 (27/10/2026) — el taller de plantillas del operador.
//
// Encargar una plantilla a la IA, seguir su estado, verla con los tres
// contenidos de muestra y aprobarla. Y algo menos visible: cuando una
// plantilla queda «pendiente_navegador», ESTA página la pinta en marcos de
// 360, 1100 y 1280 px y la mide con site-template-checks.ts. No hay navegador
// en el servidor; el del operador hace ese trabajo (ver el porqué en
// site-template-checks.ts). Por eso conviene dejar la página abierta mientras
// se genera.
//
// 27/10/2026: las que admiten el color y la letra de cada negocio
// (site-style.ts) se miden también con cada muestra de color, con colores
// extremos y con cada pareja de letras (checkPlan). Y si ningún marco llega a
// cargar, la plantilla NO se da por fallida: ese día la cabecera
// frame-ancestors dejaba los marcos en blanco y las dos de oficios cayeron
// sin que se hubiera medido nada.
//
// 29/10/2026: correcciones de una aprobada. Se comprueban igual; antes de
// aplicarla se ve qué cambia (site-template-diff.ts), y cada aprobada guarda
// sus versiones anteriores para volver a ellas.
// =============================================================================

export interface SiteTemplateRow {
  id: string;
  nombre: string;
  sector: string | null;
  variante: string | null;
  origen: string;
  modelo: string | null;
  estado: string;
  validacion: {
    encargo?: string;
    rondas?: number;
    costeUsd?: number;
    problemas?: string[];
    historial?: { fase: string; at: string; detalle: string; problemas?: string[] }[];
  } | null;
  createdAt: string;
  /** Lo que admite del estilo de cada negocio (SiteTemplateStyle). */
  estilo?: CheckStyle | null;
  _count?: { websites: number };
  /** Si es una corrección: de qué plantilla (id y nombre). */
  correccionDe?: string | null;
  corrige?: string | null;
  /** Qué cambia respecto a la vigente (solo correcciones aún abiertas). */
  cambios?: TemplateDiffPart[] | null;
  /** Lo que tuvo antes de cada corrección, la más reciente primero. */
  versiones?: { id: string; createdAt: string; motivo: string | null; actorEmail: string | null }[];
}

const ESTADOS: Record<string, { label: string; pill: string }> = {
  generando: { label: 'Generando…', pill: 'pill-warning' },
  corrigiendo: { label: 'Corrigiendo…', pill: 'pill-warning' },
  pendiente_navegador: { label: 'Comprobando en este navegador', pill: 'pill-warning' },
  lista: { label: 'Lista para aprobar', pill: 'pill-success' },
  aprobada: { label: 'Aprobada', pill: 'pill-success' },
  fallida: { label: 'Fallida', pill: 'pill-danger' },
  retirada: { label: 'Retirada', pill: 'pill-muted' },
  aplicada: { label: 'Corrección aplicada', pill: 'pill-muted' },
  descartada: { label: 'Corrección descartada', pill: 'pill-muted' },
  borrador: { label: 'Borrador', pill: 'pill-muted' },
};

const SECTORES = [
  { value: 'trades', label: 'Oficios (fontanería, electricidad, reformas…)' },
  { value: 'beauty', label: 'Belleza (peluquería, estética…)' },
  { value: 'health', label: 'Salud (clínicas, fisioterapia…)' },
  { value: 'food', label: 'Restauración' },
  { value: 'professional', label: 'Servicios profesionales' },
];

const BUSY = new Set(['generando', 'corrigiendo']);

/** Pinta la plantilla en un marco fuera de la vista y la mide. */
async function measure(templateId: string, item: CheckPlanItem): Promise<CheckRun> {
  const { ancho, contenido, pagina = '', acento, tipografia } = item;
  const variant = `${acento ? `&acento=${encodeURIComponent(acento)}` : ''}${tipografia ? `&tipografia=${tipografia}` : ''}`;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  Object.assign(iframe.style, { position: 'fixed', left: '-20000px', top: '0', width: `${ancho}px`, height: '900px', border: '0' });
  iframe.src = `/api/admin/portal/site-templates/${templateId}/preview?contenido=${contenido}&pagina=${encodeURIComponent(pagina)}${variant}&comprobar=1`;
  document.body.appendChild(iframe);
  try {
    await new Promise<void>((resolve, reject) => {
      iframe.onload = () => resolve();
      iframe.onerror = () => reject(new Error('load_failed'));
      setTimeout(() => reject(new Error('timeout')), 20000);
    });
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) return { ...item, problemas: ['No se pudo leer la vista previa.'] };
    await doc.fonts?.ready;
    await new Promise((r) => setTimeout(r, 300));
    return { ...item, problemas: runSiteChecks(doc, win) };
  } catch (err) {
    return { ...item, problemas: [`La vista previa no cargó (${err instanceof Error ? err.message : 'error'}).`] };
  } finally {
    iframe.remove();
  }
}

export function SiteTemplateLab({
  initial,
  initialForm,
}: {
  initial: SiteTemplateRow[];
  initialForm?: { nombre?: string; encargo?: string; sector?: string };
}) {
  const [templates, setTemplates] = useState<SiteTemplateRow[]>(initial);
  const [form, setForm] = useState({
    nombre: initialForm?.nombre ?? '',
    sector: initialForm?.sector || 'trades',
    variante: '',
    encargo: initialForm?.encargo ?? '',
    modelo: 'claude-sonnet-5-5',
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState<{ id: string; done: number; total: number } | null>(null);
  const checkingRef = useRef<string | null>(null);
  // Las que no se pudieron ni cargar en esta sesión: no se reintentan solas
  // (seguirían fallando igual), se avisa.
  const [unreadable, setUnreadable] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const res = await fetch('/api/admin/portal/site-templates', { cache: 'no-store' });
    if (res.ok) setTemplates(((await res.json()) as { templates: SiteTemplateRow[] }).templates);
  }, []);

  // Mientras alguna se genera o se corrige, se consulta cada 5 s.
  useEffect(() => {
    if (!templates.some((t) => BUSY.has(t.estado))) return;
    const timer = setTimeout(refresh, 5000);
    return () => clearTimeout(timer);
  }, [templates, refresh]);

  // Las que esperan al navegador se miden aquí, de una en una.
  useEffect(() => {
    const pending = templates.find((t) => t.estado === 'pendiente_navegador' && !unreadable.has(t.id));
    if (!pending || checkingRef.current) return;
    checkingRef.current = pending.id;
    (async () => {
      const runs: CheckRun[] = [];
      const plan = checkPlan(pending.estilo);
      const total = plan.length;
      for (const item of plan) {
        setChecking({ id: pending.id, done: runs.length, total });
        runs.push(await measure(pending.id, item));
      }
      setChecking({ id: pending.id, done: total, total });
      const res = await fetch(`/api/admin/portal/site-templates/${pending.id}/checks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runs }),
      });
      if (res.status === 422) setUnreadable((prev) => new Set(prev).add(pending.id));
      checkingRef.current = null;
      setChecking(null);
      await refresh();
    })();
  }, [templates, refresh, unreadable]);

  async function encargar(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const res = await fetch('/api/admin/portal/site-templates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...form, variante: form.variante || null }),
    });
    setSending(false);
    if (res.status === 429) {
      setError('Se ha llegado al tope de plantillas de hoy. Vuelve mañana.');
      return;
    }
    if (!res.ok) {
      setError('No se pudo encargar. Revisa que el encargo tenga al menos una frase.');
      return;
    }
    setForm((f) => ({ ...f, nombre: '', variante: '', encargo: '' }));
    await refresh();
  }

  async function accion(id: string, accion: 'aprobar' | 'retirar' | 'reintentar' | 'descartar' | 'restaurar', version?: string) {
    await fetch(`/api/admin/portal/site-templates/${id}/estado`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(version ? { accion, version } : { accion }),
    });
    await refresh();
  }

  return (
    <div className="space-y-6">
      <form className="card space-y-3" onSubmit={encargar} aria-label="Encargar una plantilla" data-testid="site-template-form">
        <div>
          <p className="font-semibold">Encargar una plantilla a la IA</p>
          <p className="mt-1 text-xs text-kairikos-muted">
            Tarda 2–3 minutos y cuesta unos 0,26 $ con Sonnet. Deja esta página abierta: cuando esté generada, se comprueba aquí mismo
            en 360, 1100 y 1280 px con tres contenidos de prueba, y si algo falla se corrige sola.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Nombre
            <input className="input mt-1 w-full" required maxLength={80} value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} placeholder="Oficios · tubería azul" />
          </label>
          <label className="text-sm">
            Sector
            <select className="input mt-1 w-full" value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })}>
              {SECTORES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Variante (opcional)
            <input className="input mt-1 w-full" maxLength={80} value={form.variante} onChange={(e) => setForm({ ...form, variante: e.target.value })} placeholder="clara y editorial" />
          </label>
          <label className="text-sm">
            Modelo
            <select className="input mt-1 w-full" value={form.modelo} onChange={(e) => setForm({ ...form, modelo: e.target.value })}>
              <option value="claude-sonnet-5-5">Sonnet 5.5 (recomendado, ~0,26 $)</option>
              <option value="claude-opus-5-5">Opus 5.5 (~0,65 $)</option>
              <option value="claude-haiku-5-5">Haiku 5.5 (~0,02 $, más fallos)</option>
            </select>
          </label>
        </div>
        <label className="block text-sm">
          Encargo
          <textarea
            className="input mt-1 w-full"
            required
            minLength={10}
            maxLength={1500}
            rows={3}
            value={form.encargo}
            onChange={(e) => setForm({ ...form, encargo: e.target.value })}
            placeholder="Fontanería y reformas de baño en Canarias. Urgencias. Que transmita confianza, limpieza y rapidez."
          />
        </label>
        <button type="submit" className="btn-primary" disabled={sending}>
          {sending ? 'Encargando…' : 'Encargar plantilla'}
        </button>
        {error ? <p className="text-sm text-kairikos-danger">{error}</p> : null}
      </form>

      <section className="space-y-3" aria-label="Plantillas">
        <article className="card space-y-2" data-testid="site-template-base">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">Plantilla base</p>
            <span className="pill-muted">Hecha a mano · plan B</span>
          </div>
          <p className="text-xs text-kairikos-muted">La que se usa cuando un sector no tiene ninguna aprobada.</p>
          <Previews id="base" />
        </article>

        {templates.map((t) => {
          const estado = ESTADOS[t.estado] ?? { label: t.estado, pill: 'pill-muted' };
          const v = t.validacion ?? {};
          const isChecking = checking?.id === t.id;
          return (
            <article key={t.id} className="card space-y-2" data-testid="site-template-row">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{t.nombre}</p>
                {t.corrige ? <span className="pill-warning">Corrección de «{t.corrige}»</span> : null}
                <span className={estado.pill}>{isChecking ? `Comprobando ${checking.done}/${checking.total}…` : estado.label}</span>
                <span className="text-xs text-kairikos-muted">
                  {t.sector ?? 'cualquier sector'}
                  {t.variante ? ` · ${t.variante}` : ''} · {t.origen === 'manual' ? 'hecha a mano' : (t.modelo ?? 'modelo por defecto')} · {(v.costeUsd ?? 0).toFixed(2)} $ · {v.rondas ?? 0} rondas
                  {t._count ? ` · ${t._count.websites} webs` : ''}
                </span>
              </div>
              {v.encargo ? <p className="text-sm">{v.encargo}</p> : null}
              {unreadable.has(t.id) ? (
                <p className="text-sm text-kairikos-danger">
                  Este navegador no pudo cargar alguna de las vistas previas, así que no cuenta como medida y sigue pendiente. Recarga la página para
                  intentarlo otra vez; si se repite, el fallo es del portal, no de la plantilla.
                </p>
              ) : null}
              {t.estado !== 'generando' && t.estado !== 'aplicada' && t.estado !== 'descartada' ? <Previews id={t.id} estilo={t.estilo} /> : null}
              {t.cambios ? <Cambios cambios={t.cambios} /> : null}
              {v.problemas?.length ? (
                <details className="text-sm">
                  <summary className="cursor-pointer text-kairikos-danger">{v.problemas.length} problemas pendientes</summary>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                    {v.problemas.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {v.historial?.length ? (
                <details className="text-xs text-kairikos-muted">
                  <summary className="cursor-pointer">Historial</summary>
                  <ol className="mt-2 space-y-1">
                    {v.historial.map((h, i) => (
                      <li key={i}>
                        {new Date(h.at).toLocaleString('es-ES')} · {h.fase}: {h.detalle}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {t.estado === 'lista' && !t.correccionDe ? (
                  <button type="button" className="btn-primary" onClick={() => accion(t.id, 'aprobar')}>
                    Aprobar para su sector
                  </button>
                ) : null}
                {t.estado === 'lista' && t.correccionDe ? (
                  <button type="button" className="btn-primary" onClick={() => accion(t.id, 'aprobar')}>
                    Aplicar la corrección a «{t.corrige}»
                  </button>
                ) : null}
                {t.correccionDe && ['pendiente_navegador', 'lista', 'fallida'].includes(t.estado) ? (
                  <button type="button" className="btn-ghost" onClick={() => accion(t.id, 'descartar')}>
                    Descartar la corrección
                  </button>
                ) : null}
                {t.estado === 'aprobada' ? (
                  <button type="button" className="btn-ghost" onClick={() => accion(t.id, 'retirar')}>
                    Retirar (las webs que la usan siguen igual)
                  </button>
                ) : null}
                {t.estado === 'fallida' && !t.correccionDe && (v.rondas ?? 0) < 4 && !v.problemas?.includes('no_api_key') ? (
                  <button type="button" className="btn-ghost" onClick={() => accion(t.id, 'reintentar')}>
                    Comprobar y corregir otra vez
                  </button>
                ) : null}
              </div>
              {t.estado === 'lista' && t.correccionDe ? (
                <p className="text-xs text-kairikos-muted">
                  Al aplicarla, los borradores y el editor de las webs que usan «{t.corrige}» la ven al momento. Las webs ya publicadas la reciben la
                  próxima vez que se publiquen. Lo que había queda guardado y se puede volver a ello.
                </p>
              ) : null}
              {t.estado === 'aprobada' && t.versiones?.length ? (
                <details className="text-xs">
                  <summary className="cursor-pointer text-kairikos-muted">Versiones anteriores ({t.versiones.length})</summary>
                  <ul className="mt-2 space-y-2">
                    {t.versiones.map((ver) => (
                      <li key={ver.id} className="flex flex-wrap items-center gap-2">
                        <span>
                          Sustituida el {new Date(ver.createdAt).toLocaleString('es-ES')}
                          {ver.motivo ? ` · ${ver.motivo}` : ''}
                          {ver.actorEmail ? ` · ${ver.actorEmail}` : ''}
                        </span>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => {
                            if (window.confirm('¿Volver a esta versión? Lo de ahora se guarda y se puede recuperar.')) void accion(t.id, 'restaurar', ver.id);
                          }}
                        >
                          Volver a esta versión
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </article>
          );
        })}
      </section>
    </div>
  );
}

/** Qué cambia una corrección: por pieza, lo que se quita y lo que entra. */
function Cambios({ cambios }: { cambios: TemplateDiffPart[] }) {
  if (!cambios.length) return <p className="text-sm text-kairikos-muted">No cambia nada respecto a la vigente.</p>;
  return (
    <details className="text-sm" open>
      <summary className="cursor-pointer font-medium">Qué cambia respecto a la vigente</summary>
      <div className="mt-2 space-y-3">
        {cambios.map((c) => (
          <div key={c.pieza}>
            <p className="text-xs font-semibold">{c.pieza}</p>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/5 p-2 text-xs">
              {c.quitadas.map((l, i) => (
                <span key={`q${i}`} className="block text-kairikos-danger">
                  − {l}
                </span>
              ))}
              {c.anadidas.map((l, i) => (
                <span key={`a${i}`} className="block text-kairikos-success">
                  + {l}
                </span>
              ))}
              {c.mas ? <span className="block text-kairikos-muted">… y {c.mas} líneas más</span> : null}
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}

function Previews({ id, estilo }: { id: string; estilo?: SiteTemplateRow['estilo'] }) {
  const url = (params: string) => `/api/admin/portal/site-templates/${id}/preview?contenido=normal${params}`;
  return (
    <>
      <p className="flex flex-wrap gap-3 text-sm">
        {CHECK_SAMPLES.map((s) => (
          <a key={s} className="underline" href={`/api/admin/portal/site-templates/${id}/preview?contenido=${s}`} target="_blank" rel="noopener">
            Ver con contenido {s}
          </a>
        ))}
        <a className="underline" href={`/api/admin/portal/site-templates/${id}/preview?contenido=normal&pagina=blog`} target="_blank" rel="noopener">
          Ver el blog
        </a>
        <a className="underline" href={`/api/admin/portal/site-templates/${id}/preview?contenido=normal&pagina=blog/como-detectar-una-fuga`} target="_blank" rel="noopener">
          Ver un artículo
        </a>
      </p>
      {estilo?.acento ? (
        <p className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-kairikos-muted">Colores:</span>
          {estilo.acento.muestras.map((m) => (
            <a key={m.color} className="inline-flex items-center gap-1 underline" href={url(`&acento=${encodeURIComponent(m.color)}`)} target="_blank" rel="noopener">
              <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full border border-black/20" style={{ background: m.color }} />
              {m.nombre}
            </a>
          ))}
        </p>
      ) : null}
      {estilo?.tipografias ? (
        <p className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-kairikos-muted">Letras:</span>
          {estilo.tipografias.parejas.map((p) => (
            <a key={p.id} className="underline" href={url(`&tipografia=${p.id}`)} target="_blank" rel="noopener">
              {p.nombre}
            </a>
          ))}
        </p>
      ) : null}
    </>
  );
}
