'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// SEO con IA, Fase A — the client's own half of SeoProfile's onboarding:
// business context + which site/CMS. Same shape as ProspectingProfileCard.tsx
// (controlled inputs, one PATCH, router.refresh() on success) — the
// operator's own half (WordPress technical setup) is a separate form on
// the admin side, never shown here.
// =============================================================================

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Revisa los datos del formulario.',
  forbidden: 'Este producto no está disponible en tu cuenta ahora mismo.',
  internal_error: 'Algo falló al guardar. Si persiste, contacta con el equipo técnico.',
};

const CMS_OPTIONS: { value: string; label: string }[] = [
  { value: 'wordpress', label: 'WordPress' },
  { value: 'wix', label: 'Wix' },
  { value: 'squarespace', label: 'Squarespace' },
  { value: 'other', label: 'Otra' },
  { value: 'no_se', label: 'No lo sé' },
];

export interface SeoProfile {
  businessDescription: string | null;
  targetAudience: string | null;
  toneOfVoice: string | null;
  siteUrl: string | null;
  cmsType: string | null;
}

export function SeoProfileCard({ profile }: { profile: SeoProfile | null }) {
  const router = useRouter();
  const [businessDescription, setBusinessDescription] = useState(profile?.businessDescription ?? '');
  const [targetAudience, setTargetAudience] = useState(profile?.targetAudience ?? '');
  const [toneOfVoice, setToneOfVoice] = useState(profile?.toneOfVoice ?? '');
  const [siteUrl, setSiteUrl] = useState(profile?.siteUrl ?? '');
  const [cmsType, setCmsType] = useState(profile?.cmsType ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      if (businessDescription.trim()) body.businessDescription = businessDescription.trim();
      if (targetAudience.trim()) body.targetAudience = targetAudience.trim();
      if (toneOfVoice.trim()) body.toneOfVoice = toneOfVoice.trim();
      if (siteUrl.trim()) body.siteUrl = siteUrl.trim();
      if (cmsType) body.cmsType = cmsType;

      const res = await fetch('/api/portal/seo/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
    <section className="card space-y-4" aria-label="Perfil de SEO" data-testid="seo-profile-card">
      <div>
        <p className="text-sm font-semibold">Cuéntanos de tu negocio</p>
        <p className="text-xs text-kairikos-muted">
          Con esto empezamos a preparar el contenido y la investigación de palabras clave. Puedes volver y
          completarlo cuando quieras.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-xs font-medium text-kairikos-muted">A qué se dedica tu negocio</span>
          <textarea
            className="input"
            rows={3}
            placeholder="p. ej. Peluquería de barrio especializada en color y tratamientos capilares"
            value={businessDescription}
            onChange={(e) => setBusinessDescription(e.target.value)}
            data-testid="seo-profile-business-description"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-kairikos-muted">Público objetivo</span>
          <input
            type="text"
            className="input"
            placeholder="p. ej. mujeres 25-55 años, zona centro"
            value={targetAudience}
            onChange={(e) => setTargetAudience(e.target.value)}
            data-testid="seo-profile-target-audience"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-kairikos-muted">Tono de voz</span>
          <input
            type="text"
            className="input"
            placeholder="p. ej. cercano y profesional"
            value={toneOfVoice}
            onChange={(e) => setToneOfVoice(e.target.value)}
            data-testid="seo-profile-tone"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-kairikos-muted">URL de tu sitio web</span>
          <input
            type="text"
            className="input"
            placeholder="https://tunegocio.es"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            data-testid="seo-profile-site-url"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-kairikos-muted">¿Qué usa tu sitio para publicar?</span>
          <select
            className="input"
            value={cmsType}
            onChange={(e) => setCmsType(e.target.value)}
            data-testid="seo-profile-cms-type"
          >
            <option value="">Selecciona una opción</option>
            {CMS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <button
          type="button"
          className="btn-primary"
          onClick={save}
          disabled={saving}
          data-testid="seo-profile-save"
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>

      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="seo-profile-error">
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="text-sm text-kairikos-success" data-testid="seo-profile-saved">
          Guardado.
        </p>
      ) : null}
    </section>
  );
}
