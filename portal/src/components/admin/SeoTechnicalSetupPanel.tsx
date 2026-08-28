'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SeoAuditPanel, type SeoAuditResultData } from './SeoAuditPanel';

// =============================================================================
// SEO con IA, Fase A — the operator's half of SeoProfile's onboarding: the
// WordPress technical publish access a non-technical client can't set up
// alone. Shows the client's own fields read-only for context, and an
// editable form for the technical fields only — same column-segmentation
// as the schema itself (SeoProfile's comment).
//
// Also includes the per-client content-cadence override — not a
// WordPress field, but still an operator-only per-client setting on the
// same row (see the technical-setup route's header for why it rides the
// same PATCH). Shown against globalMinIntervalDays (from
// /admin/portal/settings/seo) for context, with its own save action
// since it needs an explicit "clear back to null" affordance the rest
// of this form's fields don't.
// =============================================================================

export interface SeoQueryOpportunity {
  query: string;
  impressions: number;
  clicks: number;
  position: number;
}

export interface SeoProfilePanelData {
  businessDescription: string | null;
  targetAudience: string | null;
  toneOfVoice: string | null;
  siteUrl: string | null;
  cmsType: string | null;
  wordpressUrl: string | null;
  wordpressUsername: string | null;
  hasAppPassword: boolean;
  technicalSetupNotes: string | null;
  technicalSetupCompletedAt: string | null;
  contentGenerationMinIntervalDaysOverride: number | null;
  status: string;
  lastAuditAt: string | null;
  lastAuditResult: SeoAuditResultData | null;
  lastAuditError: string | null;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Revisa los datos del formulario.',
  not_found: 'El cliente aún no ha empezado el onboarding — pídele que rellene su parte primero.',
  internal_error: 'Algo falló al guardar. Si persiste, contacta con el equipo técnico.',
};

export function SeoTechnicalSetupPanel({
  clientId,
  profile,
  globalMinIntervalDays,
  queryOpportunities,
}: {
  clientId: string;
  profile: SeoProfilePanelData | null;
  globalMinIntervalDays: number;
  queryOpportunities: SeoQueryOpportunity[];
}) {
  const router = useRouter();
  const [wordpressUrl, setWordpressUrl] = useState(profile?.wordpressUrl ?? '');
  const [wordpressUsername, setWordpressUsername] = useState(profile?.wordpressUsername ?? '');
  const [wordpressAppPassword, setWordpressAppPassword] = useState('');
  const [technicalSetupNotes, setTechnicalSetupNotes] = useState(profile?.technicalSetupNotes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [cadenceOverride, setCadenceOverride] = useState(
    profile?.contentGenerationMinIntervalDaysOverride != null ? String(profile.contentGenerationMinIntervalDaysOverride) : '',
  );
  const [cadenceSaving, setCadenceSaving] = useState(false);
  const [cadenceError, setCadenceError] = useState<string | null>(null);
  const [cadenceSaved, setCadenceSaved] = useState(false);
  const parsedCadence = Number(cadenceOverride);
  const isCadenceValid = Number.isInteger(parsedCadence) && parsedCadence >= 1 && parsedCadence <= 90;

  if (!profile) {
    return (
      <p className="text-sm text-kairikos-muted" data-testid="seo-technical-setup-empty">
        El cliente aún no ha rellenado su perfil de SEO.
      </p>
    );
  }

  async function save() {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      if (wordpressUrl.trim()) body.wordpressUrl = wordpressUrl.trim();
      if (wordpressUsername.trim()) body.wordpressUsername = wordpressUsername.trim();
      if (wordpressAppPassword.trim()) body.wordpressAppPassword = wordpressAppPassword.trim();
      if (technicalSetupNotes.trim()) body.technicalSetupNotes = technicalSetupNotes.trim();

      const res = await fetch(`/api/admin/portal/seo/${clientId}/technical-setup`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setError(ERROR_LABEL[detail?.error] ?? 'No se pudo guardar.');
        return;
      }
      setWordpressAppPassword('');
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setSaving(false);
    }
  }

  // Deliberately a separate save action from save() above — this field
  // needs an explicit "clear back to null" affordance (revert to the
  // global default) that the rest of the form's "leave blank = don't
  // touch" fields don't need, so it can't share their all-in-one submit
  // without creating ambiguity about what an empty input means.
  async function saveCadence(days: number | null) {
    setCadenceError(null);
    setCadenceSaved(false);
    setCadenceSaving(true);
    try {
      const res = await fetch(`/api/admin/portal/seo/${clientId}/technical-setup`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentGenerationMinIntervalDaysOverride: days }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        setCadenceError(ERROR_LABEL[detail?.error] ?? 'No se pudo guardar.');
        return;
      }
      setCadenceOverride(days != null ? String(days) : '');
      setCadenceSaved(true);
      router.refresh();
    } catch (err) {
      setCadenceError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setCadenceSaving(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="seo-technical-setup-panel">
      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-kairikos-muted">Negocio</dt>
          <dd>{profile.businessDescription ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-kairikos-muted">Público objetivo</dt>
          <dd>{profile.targetAudience ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-kairikos-muted">Sitio</dt>
          <dd>{profile.siteUrl ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-kairikos-muted">CMS indicado por el cliente</dt>
          <dd>{profile.cmsType ?? '—'}</dd>
        </div>
      </dl>

      <div className="border-t border-kairikos-border pt-4">
        <p className="mb-1 text-sm font-semibold">Acceso técnico de publicación</p>
        <p className="mb-3 text-xs text-kairikos-muted" data-testid="seo-technical-setup-status">
          {profile.technicalSetupCompletedAt
            ? `Configurado — última confirmación ${new Date(profile.technicalSetupCompletedAt).toLocaleDateString('es-ES')}.`
            : 'Pendiente de configurar.'}
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-kairikos-muted">URL de WordPress</span>
            <input
              type="text"
              className="input"
              placeholder="https://tunegocio.es/wp-admin"
              value={wordpressUrl}
              onChange={(e) => setWordpressUrl(e.target.value)}
              data-testid="seo-technical-wordpress-url"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-kairikos-muted">Usuario</span>
            <input
              type="text"
              className="input"
              value={wordpressUsername}
              onChange={(e) => setWordpressUsername(e.target.value)}
              data-testid="seo-technical-wordpress-username"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-kairikos-muted">
              Application Password {profile.hasAppPassword ? '(ya hay una guardada)' : ''}
            </span>
            <input
              type="password"
              className="input"
              placeholder={profile.hasAppPassword ? '•••••••• (dejar en blanco para no cambiarla)' : ''}
              value={wordpressAppPassword}
              onChange={(e) => setWordpressAppPassword(e.target.value)}
              autoComplete="off"
              data-testid="seo-technical-wordpress-app-password"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="text-xs font-medium text-kairikos-muted">Notas</span>
            <textarea
              className="input"
              rows={2}
              value={technicalSetupNotes}
              onChange={(e) => setTechnicalSetupNotes(e.target.value)}
              data-testid="seo-technical-notes"
            />
          </label>
        </div>
        <button
          type="button"
          className="btn-primary mt-3"
          onClick={save}
          disabled={saving}
          data-testid="seo-technical-setup-save"
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
        {error ? (
          <p className="mt-2 text-sm text-kairikos-danger" data-testid="seo-technical-setup-error">
            {error}
          </p>
        ) : null}
        {saved && !error ? (
          <p className="mt-2 text-sm text-kairikos-success" data-testid="seo-technical-setup-saved">
            Guardado.
          </p>
        ) : null}
      </div>

      <div className="border-t border-kairikos-border pt-4" data-testid="seo-cadence-override-panel">
        <p className="mb-1 text-sm font-semibold">Cadencia de contenido para este cliente</p>
        <p className="mb-3 text-xs text-kairikos-muted">
          {profile.contentGenerationMinIntervalDaysOverride != null ? (
            <>
              Personalizada: cada {profile.contentGenerationMinIntervalDaysOverride} días. (Valor global:{' '}
              {globalMinIntervalDays} días.)
            </>
          ) : (
            <>Usa el valor global ({globalMinIntervalDays} días).</>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={90}
              step={1}
              className="input w-24"
              value={cadenceOverride}
              onChange={(e) => setCadenceOverride(e.target.value)}
              placeholder={String(globalMinIntervalDays)}
              data-testid="seo-cadence-override-input"
            />
            <span className="text-sm text-kairikos-muted">días</span>
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={!isCadenceValid || cadenceSaving}
            onClick={() => saveCadence(parsedCadence)}
            data-testid="seo-cadence-override-save"
          >
            {cadenceSaving ? 'Guardando…' : 'Guardar cadencia personalizada'}
          </button>
          {profile.contentGenerationMinIntervalDaysOverride != null ? (
            <button
              type="button"
              className="btn-ghost"
              disabled={cadenceSaving}
              onClick={() => saveCadence(null)}
              data-testid="seo-cadence-override-clear"
            >
              Usar el valor global
            </button>
          ) : null}
        </div>
        {cadenceError ? (
          <p className="mt-2 text-sm text-kairikos-danger" data-testid="seo-cadence-override-error">
            {cadenceError}
          </p>
        ) : null}
        {cadenceSaved && !cadenceError ? (
          <p className="mt-2 text-sm text-kairikos-success" data-testid="seo-cadence-override-saved">
            Guardado.
          </p>
        ) : null}
      </div>

      <SeoAuditPanel
        clientId={clientId}
        hasSiteUrl={Boolean(profile.siteUrl)}
        lastAuditAt={profile.lastAuditAt}
        lastAuditResult={profile.lastAuditResult}
        lastAuditError={profile.lastAuditError}
      />

      <div className="border-t border-kairikos-border pt-4" data-testid="seo-query-opportunities-panel">
        <p className="mb-1 text-sm font-semibold">Oportunidades de contenido</p>
        <p className="mb-3 text-xs text-kairikos-muted">
          Consultas de Google donde el sitio ya aparece (posición 4-20) — la señal que usa la generación de
          artículos para elegir sobre qué escribir. Solo lectura; requiere Search Console conectado y
          sincronizado.
        </p>
        {queryOpportunities.length === 0 ? (
          <p className="text-sm text-kairikos-muted" data-testid="seo-query-opportunities-empty">
            Todavía no hay oportunidades detectadas.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="seo-query-opportunities-table">
              <thead>
                <tr className="text-left text-xs text-kairikos-muted">
                  <th className="pb-2 pr-4 font-medium">Consulta</th>
                  <th className="pb-2 pr-4 font-medium">Posición</th>
                  <th className="pb-2 pr-4 font-medium">Impresiones</th>
                  <th className="pb-2 font-medium">Clics</th>
                </tr>
              </thead>
              <tbody>
                {queryOpportunities.map((o) => (
                  <tr key={o.query} className="border-t border-kairikos-border" data-testid="seo-query-opportunity-row">
                    <td className="py-1.5 pr-4">{o.query}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{o.position}</td>
                    <td className="py-1.5 pr-4 tabular-nums">{o.impressions.toLocaleString('es-ES')}</td>
                    <td className="py-1.5 tabular-nums">{o.clicks.toLocaleString('es-ES')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
