'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// /admin/portal/settings/seo — the operator's cadence knob for
// lib/seo-content-generation.ts (see lib/seo-settings.ts's header for
// why this is operator-configurable instead of a hardcoded constant).
// Same form shape as IntegrationCredentialsPanel: fetch the current
// value server-side, save via a client component, router.refresh() on
// success.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'El número de días debe ser un entero entre 1 y 90.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  service_unavailable: 'No disponible en este momento.',
  internal_error: 'Algo falló en el servidor. Si persiste, contacta con el equipo técnico.',
};

function errorLabel(code: string | undefined): string {
  return (code && ERROR_LABEL[code]) || 'No se pudo guardar.';
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export function SeoSettingsPanel({ initialMinIntervalDays }: { initialMinIntervalDays: number }) {
  const router = useRouter();
  const [value, setValue] = useState(String(initialMinIntervalDays));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const parsed = Number(value);
  const isValid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 90;
  const approxArticlesPerMonth = isValid ? Math.round(30 / parsed) : null;

  async function save() {
    setError(null);
    setSaved(false);
    if (!isValid) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/portal/settings/seo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentGenerationMinIntervalDays: parsed }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setError(errorLabel(body.error as string | undefined));
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
    <section className="card space-y-4" aria-label="Cadencia de contenido" data-testid="seo-settings-card">
      <div>
        <p className="font-semibold">Cadencia de generación de artículos</p>
        <p className="mt-1 text-xs text-kairikos-muted">
          Cada cuántos días se pide un nuevo artículo por cliente. Un valor más bajo genera más artículos al mes,
          pero también más llamadas a n8n/IA y más borradores que revisar.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={90}
            step={1}
            className="input w-24"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="seo-settings-interval-input"
          />
          <span className="text-sm text-kairikos-muted">días</span>
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={!isValid || saving}
          onClick={save}
          data-testid="seo-settings-save"
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
      {isValid ? (
        <p className="text-xs text-kairikos-muted" data-testid="seo-settings-approx">
          ≈ {approxArticlesPerMonth} artículo{approxArticlesPerMonth === 1 ? '' : 's'} al mes por cliente.
        </p>
      ) : (
        <p className="text-xs text-kairikos-danger">Introduce un entero entre 1 y 90.</p>
      )}
      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="seo-settings-error">
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="text-sm text-kairikos-success" data-testid="seo-settings-saved">
          Guardado.
        </p>
      ) : null}
    </section>
  );
}
