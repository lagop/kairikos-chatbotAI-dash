'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { KeywordTrend } from '@/lib/seo-keywords';

// =============================================================================
// Fase 3.1 — las palabras por las que el cliente quiere posicionar, y cómo
// va cada una.
//
// Mismo patrón que SeoProfileCard/ProspectingProfileCard: entradas
// controladas, un PUT con la lista entera, router.refresh() al guardar.
//
// La posición se muestra tal cual la da Google (11,4) y el cambio se
// expresa en "puestos ganados", porque mejorar en SEO es bajar de número y
// enseñar un "-6" para una mejora se lee al revés de lo que significa.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Revisa la lista: cada palabra necesita al menos dos caracteres.',
  forbidden: 'Completa antes tu perfil de SEO.',
  internal_error: 'Algo falló al guardar. Si persiste, contacta con el equipo técnico.',
};

export const MAX_KEYWORDS_HINT = 20;

function PositionCell({ trend }: { trend: KeywordTrend }) {
  if (trend.position === null) {
    return (
      <span className="text-sm text-kairikos-muted" title="Google todavía no te muestra por esta búsqueda">
        Sin posición
      </span>
    );
  }
  return (
    <span className="text-sm font-semibold tabular-nums text-kairikos-text">
      {trend.position.toFixed(1)}
    </span>
  );
}

function ChangeCell({ change }: { change: number | null }) {
  if (change === null) {
    return <span className="text-xs text-kairikos-muted">Sin comparación aún</span>;
  }
  if (Math.abs(change) < 0.1) {
    return <span className="text-xs text-kairikos-muted">Estable</span>;
  }
  const up = change > 0;
  return (
    <span className={`text-xs font-medium ${up ? 'text-kairikos-success' : 'text-kairikos-danger'}`}>
      {up ? '▲' : '▼'} {Math.abs(change).toFixed(1)} {Math.abs(change) === 1 ? 'puesto' : 'puestos'}
    </span>
  );
}

export function SeoKeywordsCard({
  trends,
  clientProductId,
}: {
  trends: KeywordTrend[];
  /** Fase 2 multi-instancia — de qué web es esta tarjeta. Se manda en cada
   *  escritura: sin él, el servidor resolvería "la única que haya" y con dos
   *  webs se negaría, que es correcto pero inútil desde aquí. */
  clientProductId: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(trends.map((t) => t.keyword).join('\n'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setError(null);
    setSaved(false);
    const keywords = value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (keywords.length > MAX_KEYWORDS_HINT) {
      setError(`Como máximo ${MAX_KEYWORDS_HINT} palabras: con más, la lista deja de ser una estrategia.`);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/portal/seo/keywords', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords, clientProductId }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo guardar.');
        return;
      }
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card space-y-4" aria-label="Palabras clave objetivo" data-testid="seo-keywords-card">
      <div>
        <p className="text-sm font-semibold">¿Por qué búsquedas quieres que te encuentren?</p>
        <p className="text-xs text-kairikos-muted">
          Escribe una por línea. Cada día guardamos en qué posición apareces por cada una, para que veas si subes.
        </p>
      </div>

      {trends.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-left text-sm" data-testid="seo-keywords-table">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-kairikos-muted">
                <th className="pb-2 font-medium">Búsqueda</th>
                <th className="pb-2 font-medium">Posición</th>
                <th className="pb-2 font-medium">Últimos 30 días</th>
                <th className="pb-2 text-right font-medium">Clics</th>
              </tr>
            </thead>
            <tbody>
              {trends.map((trend) => (
                <tr key={trend.id} className="border-t border-kairikos-border" data-testid="seo-keyword-row">
                  <td className="py-2 pr-3">{trend.keyword}</td>
                  <td className="py-2 pr-3">
                    <PositionCell trend={trend} />
                  </td>
                  <td className="py-2 pr-3">
                    <ChangeCell change={trend.change} />
                  </td>
                  <td className="py-2 text-right tabular-nums text-kairikos-muted">{trend.clicks}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-kairikos-muted">
            La posición 1 es la primera de Google: cuanto más bajo el número, mejor.
          </p>
        </div>
      ) : null}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-kairikos-muted">Tus búsquedas objetivo</span>
        <textarea
          className="input"
          rows={5}
          placeholder={'mechas babylights las palmas\ncorte de pelo con cita previa'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid="seo-keywords-input"
        />
      </label>

      <button
        type="button"
        className="btn-primary"
        onClick={save}
        disabled={saving}
        data-testid="seo-keywords-save"
      >
        {saving ? 'Guardando…' : 'Guardar'}
      </button>

      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="seo-keywords-error">
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="text-sm text-kairikos-success" data-testid="seo-keywords-saved">
          Guardado. Las posiciones empezarán a aparecer con la próxima sincronización.
        </p>
      ) : null}
    </section>
  );
}
