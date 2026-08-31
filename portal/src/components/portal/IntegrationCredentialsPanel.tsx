'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// =============================================================================
// /admin/portal/settings/integrations — the operator's own third-party API
// keys, stored encrypted in this DB (see integration-credentials.ts's
// header for why this is a different model from OperatorSettings).
// Deliberately not on /admin/portal/settings/billing — Google Places has
// nothing to do with Stripe or client billing. Same shape as
// StripeCatalogSettingsPanel's own credential form, without the
// test/live-mode duality or TOTP step-up (see the save routes' own
// headers for why these keys don't need step-up).
//
// Google Business/SEO/GA4 are OAuth CLIENT registrations (a public
// client_id + a secret), not a plain API key like Google Places — see
// SavedCredentialCard's `clientIdLabel` prop for the two-field variant.
// =============================================================================

export interface IntegrationCredentialStatus {
  configured: boolean;
  lastFour: string | null;
  savedAt: string | null;
  clientId: string | null;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Revisa que los campos están completos y se copiaron enteros.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  service_unavailable: 'No disponible en este momento.',
  internal_error: 'Algo falló en el servidor. Si persiste, contacta con el equipo técnico.',
};

function errorLabel(code: string | undefined): string {
  return (code && ERROR_LABEL[code]) || 'No se pudo completar la operación.';
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(iso));
}

async function safeJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/** Single API-key tool, e.g. Google Places — one secret field. */
function ApiKeyCard({
  toolKey,
  title,
  description,
  endpoint,
  placeholder,
  initial,
}: {
  toolKey: string;
  title: string;
  description: string;
  endpoint: string;
  placeholder: string;
  initial: IntegrationCredentialStatus;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setError(null);
    setSaved(false);
    if (!apiKey.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setError(errorLabel(body.error as string | undefined));
        return;
      }
      setStatus((s) => ({ ...s, configured: true, lastFour: body.lastFour as string, savedAt: new Date().toISOString() }));
      setApiKey('');
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card space-y-4" aria-label={title} data-testid={`integration-${toolKey}-card`}>
      <div className="flex items-center justify-between">
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-kairikos-muted" data-testid={`integration-${toolKey}-status`}>
          {status.configured ? `•••• ${status.lastFour} — guardada ${formatDate(status.savedAt)}` : 'Sin configurar'}
        </p>
      </div>
      <p className="text-xs text-kairikos-muted">{description}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="password"
          className="input flex-1"
          placeholder={placeholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          data-testid={`integration-${toolKey}-input`}
          autoComplete="off"
        />
        <button
          type="button"
          className="btn-primary"
          disabled={!apiKey.trim() || saving}
          onClick={save}
          data-testid={`integration-${toolKey}-save`}
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid={`integration-${toolKey}-error`}>
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="text-sm text-kairikos-success" data-testid={`integration-${toolKey}-saved`}>
          Guardado.
        </p>
      ) : null}
    </section>
  );
}

/** OAuth-client tool (Google Business/SEO/GA4) — client_id (cleartext,
 *  shown once saved) + client_secret (masked, like ApiKeyCard's key). */
function OAuthClientCard({
  toolKey,
  title,
  description,
  endpoint,
  initial,
}: {
  toolKey: string;
  title: string;
  description: string;
  endpoint: string;
  initial: IntegrationCredentialStatus;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setError(null);
    setSaved(false);
    if (!clientId.trim() || !clientSecret.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientId.trim(), clientSecret: clientSecret.trim() }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setError(errorLabel(body.error as string | undefined));
        return;
      }
      setStatus((s) => ({
        ...s,
        configured: true,
        clientId: body.clientId as string,
        lastFour: body.lastFour as string,
        savedAt: new Date().toISOString(),
      }));
      setClientId('');
      setClientSecret('');
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card space-y-4" aria-label={title} data-testid={`integration-${toolKey}-card`}>
      <div className="flex items-center justify-between">
        <p className="font-semibold">{title}</p>
        <p className="text-sm text-kairikos-muted" data-testid={`integration-${toolKey}-status`}>
          {status.configured
            ? `${status.clientId} (•••• ${status.lastFour}) — guardada ${formatDate(status.savedAt)}`
            : 'Sin configurar'}
        </p>
      </div>
      <p className="text-xs text-kairikos-muted">{description}</p>
      <div className="flex flex-col gap-2">
        <input
          type="text"
          className="input"
          placeholder="Client ID (…apps.googleusercontent.com)"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          data-testid={`integration-${toolKey}-client-id-input`}
          autoComplete="off"
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            className="input flex-1"
            placeholder="Client secret"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            data-testid={`integration-${toolKey}-client-secret-input`}
            autoComplete="off"
          />
          <button
            type="button"
            className="btn-primary"
            disabled={!clientId.trim() || !clientSecret.trim() || saving}
            onClick={save}
            data-testid={`integration-${toolKey}-save`}
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid={`integration-${toolKey}-error`}>
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="text-sm text-kairikos-success" data-testid={`integration-${toolKey}-saved`}>
          Guardado.
        </p>
      ) : null}
    </section>
  );
}

export function IntegrationCredentialsPanel({
  initialGooglePlaces,
  initialGoogleBusiness,
  initialGoogleSeo,
  initialGoogleGa4,
}: {
  initialGooglePlaces: IntegrationCredentialStatus;
  initialGoogleBusiness: IntegrationCredentialStatus;
  initialGoogleSeo: IntegrationCredentialStatus;
  initialGoogleGa4: IntegrationCredentialStatus;
}) {
  return (
    <div className="space-y-4">
      <ApiKeyCard
        toolKey="google-places"
        title="Google Places"
        description="Usada por Prospección con IA para buscar negocios con la API de Google Places (New)."
        endpoint="/api/admin/portal/settings/integrations/google-places"
        placeholder="AIza..."
        initial={initialGooglePlaces}
      />
      <OAuthClientCard
        toolKey="google-business"
        title="Google Business (Reseñas/Recall)"
        description="Cliente OAuth con el que los clientes conectan su Google Business Profile — usado por Reseñas y por el bloque de reseñas de Recall."
        endpoint="/api/admin/portal/settings/integrations/google-business"
        initial={initialGoogleBusiness}
      />
      <OAuthClientCard
        toolKey="google-seo"
        title="Google Search Console (SEO)"
        description="Cliente OAuth con el que los clientes conectan su propiedad de Search Console — usado por SEO con IA, Fase B."
        endpoint="/api/admin/portal/settings/integrations/google-seo"
        initial={initialGoogleSeo}
      />
      <OAuthClientCard
        toolKey="google-ga4"
        title="Google Analytics (GA4, SEO)"
        description="Cliente OAuth con el que los clientes conectan su propiedad de GA4 — usado por SEO con IA."
        endpoint="/api/admin/portal/settings/integrations/google-ga4"
        initial={initialGoogleGa4}
      />
    </div>
  );
}
