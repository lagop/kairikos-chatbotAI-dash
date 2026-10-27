'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CHECK_SAMPLES, CHECK_WIDTHS, runSiteChecks, type CheckRun } from '@/lib/site-template-checks';

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
  _count?: { websites: number };
}

const ESTADOS: Record<string, { label: string; pill: string }> = {
  generando: { label: 'Generando…', pill: 'pill-warning' },
  corrigiendo: { label: 'Corrigiendo…', pill: 'pill-warning' },
  pendiente_navegador: { label: 'Comprobando en este navegador', pill: 'pill-warning' },
  lista: { label: 'Lista para aprobar', pill: 'pill-success' },
  aprobada: { label: 'Aprobada', pill: 'pill-success' },
  fallida: { label: 'Fallida', pill: 'pill-danger' },
  retirada: { label: 'Retirada', pill: 'pill-muted' },
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
async function measure(templateId: string, contenido: (typeof CHECK_SAMPLES)[number], ancho: number): Promise<CheckRun> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.tabIndex = -1;
  Object.assign(iframe.style, { position: 'fixed', left: '-20000px', top: '0', width: `${ancho}px`, height: '900px', border: '0' });
  iframe.src = `/api/admin/portal/site-templates/${templateId}/preview?contenido=${contenido}&comprobar=1`;
  document.body.appendChild(iframe);
  try {
    await new Promise<void>((resolve, reject) => {
      iframe.onload = () => resolve();
      iframe.onerror = () => reject(new Error('load_failed'));
      setTimeout(() => reject(new Error('timeout')), 20000);
    });
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) return { ancho, contenido, problemas: ['No se pudo leer la vista previa.'] };
    await doc.fonts?.ready;
    await new Promise((r) => setTimeout(r, 300));
    return { ancho, contenido, problemas: runSiteChecks(doc, win) };
  } catch (err) {
    return { ancho, contenido, problemas: [`La vista previa no cargó (${err instanceof Error ? err.message : 'error'}).`] };
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
    const pending = templates.find((t) => t.estado === 'pendiente_navegador');
    if (!pending || checkingRef.current) return;
    checkingRef.current = pending.id;
    (async () => {
      const runs: CheckRun[] = [];
      const total = CHECK_SAMPLES.length * CHECK_WIDTHS.length;
      for (const contenido of CHECK_SAMPLES) {
        for (const ancho of CHECK_WIDTHS) {
          setChecking({ id: pending.id, done: runs.length, total });
          runs.push(await measure(pending.id, contenido, ancho));
        }
      }
      setChecking({ id: pending.id, done: total, total });
      await fetch(`/api/admin/portal/site-templates/${pending.id}/checks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runs }),
      });
      checkingRef.current = null;
      setChecking(null);
      await refresh();
    })();
  }, [templates, refresh]);

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

  async function accion(id: string, accion: 'aprobar' | 'retirar' | 'reintentar') {
    await fetch(`/api/admin/portal/site-templates/${id}/estado`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accion }),
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
                <span className={estado.pill}>{isChecking ? `Comprobando ${checking.done}/${checking.total}…` : estado.label}</span>
                <span className="text-xs text-kairikos-muted">
                  {t.sector ?? 'cualquier sector'}
                  {t.variante ? ` · ${t.variante}` : ''} · {t.modelo ?? 'modelo por defecto'} · {(v.costeUsd ?? 0).toFixed(2)} $ · {v.rondas ?? 0} rondas
                  {t._count ? ` · ${t._count.websites} webs` : ''}
                </span>
              </div>
              {v.encargo ? <p className="text-sm">{v.encargo}</p> : null}
              {t.estado !== 'generando' ? <Previews id={t.id} /> : null}
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
                {t.estado === 'lista' ? (
                  <button type="button" className="btn-primary" onClick={() => accion(t.id, 'aprobar')}>
                    Aprobar para su sector
                  </button>
                ) : null}
                {t.estado === 'aprobada' ? (
                  <button type="button" className="btn-ghost" onClick={() => accion(t.id, 'retirar')}>
                    Retirar (las webs que la usan siguen igual)
                  </button>
                ) : null}
                {t.estado === 'fallida' && (v.rondas ?? 0) < 4 && !v.problemas?.includes('no_api_key') ? (
                  <button type="button" className="btn-ghost" onClick={() => accion(t.id, 'reintentar')}>
                    Comprobar y corregir otra vez
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}

function Previews({ id }: { id: string }) {
  return (
    <p className="flex flex-wrap gap-3 text-sm">
      {CHECK_SAMPLES.map((s) => (
        <a key={s} className="underline" href={`/api/admin/portal/site-templates/${id}/preview?contenido=${s}`} target="_blank" rel="noopener">
          Ver con contenido {s}
        </a>
      ))}
    </p>
  );
}
