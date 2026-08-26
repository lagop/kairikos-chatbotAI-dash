'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// Prospección con IA, Fase A — the client's own target-profile settings:
// what kind of business, and where. Deliberately self-serve — see
// prospecting-campaign route's header for why this is NOT an
// operator-managed setting. Same shape as ConversationDigestsPanel.tsx:
// controlled inputs, one PATCH, router.refresh() on success.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Revisa los datos — falta el rubro o la zona.',
  forbidden: 'Este producto no está disponible en tu cuenta ahora mismo.',
  internal_error: 'Algo falló al guardar. Si persiste, contacta con el equipo técnico.',
};

export interface ProspectingProfile {
  category: string | null;
  locationQuery: string | null;
  radiusMeters: number | null;
}

export function ProspectingProfileCard({ profile }: { profile: ProspectingProfile | null }) {
  const router = useRouter();
  const [category, setCategory] = useState(profile?.category ?? '');
  const [locationQuery, setLocationQuery] = useState(profile?.locationQuery ?? '');
  const [radiusKm, setRadiusKm] = useState(Math.round((profile?.radiusMeters ?? 10000) / 1000));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const configured = Boolean(profile?.category && profile?.locationQuery);

  async function save() {
    setError(null);
    setSaved(false);
    if (!category.trim() || !locationQuery.trim()) {
      setError(ERROR_LABEL.invalid_body);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/portal/prospecting/campaign', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: category.trim(),
          locationQuery: locationQuery.trim(),
          radiusMeters: Math.min(Math.max(radiusKm, 1), 50) * 1000,
        }),
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
    <section className="card space-y-4" aria-label="Perfil de prospección" data-testid="prospecting-profile-card">
      <div>
        <p className="text-sm font-semibold">¿A quién buscamos?</p>
        <p className="text-xs text-kairikos-muted">
          {configured
            ? 'Cambia el rubro o la zona cuando quieras — el siguiente barrido usará el perfil nuevo.'
            : 'Dinos qué tipo de negocio y en qué zona, y empezamos a buscarte prospectos.'}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-kairikos-muted">Rubro</span>
          <input
            type="text"
            className="input"
            placeholder="p. ej. peluquerías"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            data-testid="prospecting-profile-category"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-kairikos-muted">Zona</span>
          <input
            type="text"
            className="input"
            placeholder="p. ej. Las Palmas de Gran Canaria"
            value={locationQuery}
            onChange={(e) => setLocationQuery(e.target.value)}
            data-testid="prospecting-profile-location"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-kairikos-muted">Radio (km)</span>
          <input
            type="number"
            min={1}
            max={50}
            className="input w-20"
            value={radiusKm}
            onChange={(e) => setRadiusKm(Number(e.target.value) || 1)}
            data-testid="prospecting-profile-radius"
          />
        </label>
        <button
          type="button"
          className="btn-primary"
          onClick={save}
          disabled={saving}
          data-testid="prospecting-profile-save"
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>

      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="prospecting-profile-error">
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="text-sm text-kairikos-success" data-testid="prospecting-profile-saved">
          Guardado.
        </p>
      ) : null}
    </section>
  );
}
