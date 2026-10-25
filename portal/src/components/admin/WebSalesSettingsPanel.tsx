'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// 25/10/2026 — /admin/portal/settings/web: el tope de webs por autoservicio
// (lib/web-self-serve.ts). Mismo formulario que SeoSettingsPanel. Los límites
// se repiten aquí en vez de importar el lib, que es de servidor.
// =============================================================================

const MIN_CAP = 0;
const MAX_CAP = 50;

const ERROR_LABEL: Record<string, string> = {
  invalid_body: `El tope debe ser un entero entre ${MIN_CAP} y ${MAX_CAP}.`,
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  service_unavailable: 'No disponible en este momento.',
  internal_error: 'Algo falló en el servidor. Si persiste, contacta con el equipo técnico.',
};

export function WebSalesSettingsPanel({
  initialCap,
  soldThisMonth,
  pendingCheckouts,
}: {
  initialCap: number;
  soldThisMonth: number;
  pendingCheckouts: number;
}) {
  const router = useRouter();
  const [value, setValue] = useState(String(initialCap));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const parsed = Number(value);
  const isValid = Number.isInteger(parsed) && parsed >= MIN_CAP && parsed <= MAX_CAP;

  async function save() {
    setError(null);
    setSaved(false);
    if (!isValid) return;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/portal/settings/web', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selfServeMonthlyCap: parsed }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError((body.error && ERROR_LABEL[body.error]) || 'No se pudo guardar.');
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
    <section className="card space-y-4" aria-label="Webs por autoservicio" data-testid="web-sales-settings-card">
      <div>
        <p className="font-semibold">Webs al mes que se pueden comprar sin llamada</p>
        <p className="mt-1 text-xs text-kairikos-muted">
          Cada web son horas de trabajo. Al llegar al tope, el botón «La quiero» del borrador se convierte en «Reservar
          una llamada» hasta el mes siguiente. 0 apaga la compra desde el borrador. Las webs por presupuesto no cuentan.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={MIN_CAP}
            max={MAX_CAP}
            step={1}
            className="input w-24"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            data-testid="web-sales-cap-input"
          />
          <span className="text-sm text-kairikos-muted">webs al mes</span>
        </div>
        <button type="button" className="btn-primary" disabled={!isValid || saving} onClick={save}>
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
      <p className="text-xs text-kairikos-muted" data-testid="web-sales-usage">
        Este mes: {soldThisMonth} pagada{soldThisMonth === 1 ? '' : 's'}
        {pendingCheckouts > 0 ? ` y ${pendingCheckouts} con el pago abierto` : ''}.
      </p>
      {!isValid ? <p className="text-xs text-kairikos-danger">Introduce un entero entre {MIN_CAP} y {MAX_CAP}.</p> : null}
      {error ? <p className="text-sm text-kairikos-danger">{error}</p> : null}
      {saved && !error ? <p className="text-sm text-kairikos-success">Guardado.</p> : null}
    </section>
  );
}
