'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// SEO con IA — the property-picker shown when a GoogleAnalyticsConnection
// sits in 'pending_property_selection'. Fetches the live property list
// itself on mount (GET /api/portal/seo/analytics/properties) rather than
// the page doing it during SSR — see that route's own comment for why.
// =============================================================================

interface AnalyticsProperty {
  propertyId: string;
  displayName: string;
  accountDisplayName: string;
}

export function SeoAnalyticsPicker() {
  const router = useRouter();
  const [properties, setProperties] = useState<AnalyticsProperty[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/portal/seo/analytics/properties');
        if (cancelled) return;
        if (!res.ok) {
          setLoadError('No se pudo cargar la lista de propiedades de Analytics.');
          return;
        }
        const body = await res.json();
        setProperties(body.properties ?? []);
        if (body.properties?.length > 0) setSelected(body.properties[0].propertyId);
      } catch (err) {
        if (!cancelled) setLoadError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function confirm() {
    if (!selected) return;
    setSaveError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/portal/seo/analytics/select-property', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ propertyId: selected }),
      });
      if (!res.ok) {
        setSaveError('No se pudo completar la conexión. Inténtalo de nuevo.');
        return;
      }
      router.refresh();
    } catch (err) {
      setSaveError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <p className="text-sm text-kairikos-danger" data-testid="seo-analytics-picker-error">
        {loadError}
      </p>
    );
  }

  if (properties === null) {
    return (
      <p className="text-sm text-kairikos-muted" data-testid="seo-analytics-picker-loading">
        Cargando tus propiedades de Analytics…
      </p>
    );
  }

  if (properties.length === 0) {
    return (
      <p className="text-sm text-kairikos-muted" data-testid="seo-analytics-picker-empty">
        No encontramos ninguna propiedad de Google Analytics en esa cuenta. Conecta la cuenta de Google que
        administra tu Analytics.
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="seo-analytics-picker">
      <p className="text-sm">Elige qué propiedad de Analytics es la de tu sitio:</p>
      <select className="input" value={selected} onChange={(e) => setSelected(e.target.value)} data-testid="seo-analytics-picker-select">
        {properties.map((p) => (
          <option key={p.propertyId} value={p.propertyId}>
            {p.displayName} ({p.accountDisplayName})
          </option>
        ))}
      </select>
      <button type="button" className="btn-primary" disabled={saving} onClick={confirm} data-testid="seo-analytics-picker-confirm">
        {saving ? 'Confirmando…' : 'Confirmar'}
      </button>
      {saveError ? (
        <p className="text-sm text-kairikos-danger" data-testid="seo-analytics-picker-save-error">
          {saveError}
        </p>
      ) : null}
    </div>
  );
}
