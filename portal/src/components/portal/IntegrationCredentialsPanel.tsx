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
// test/live-mode duality or TOTP step-up (see the save route's header for
// why this key doesn't need step-up).
// =============================================================================

export interface IntegrationCredentialStatus {
  configured: boolean;
  lastFour: string | null;
  savedAt: string | null;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'La clave parece demasiado corta — revisa que la copiaste completa.',
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

export function IntegrationCredentialsPanel({
  initialGooglePlaces,
}: {
  initialGooglePlaces: IntegrationCredentialStatus;
}) {
  const router = useRouter();
  const [status, setStatus] = useState(initialGooglePlaces);
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
      const res = await fetch('/api/admin/portal/settings/integrations/google-places', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const body = await safeJson(res);
      if (!res.ok) {
        setError(errorLabel(body.error as string | undefined));
        return;
      }
      setStatus({ configured: true, lastFour: body.lastFour as string, savedAt: new Date().toISOString() });
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
    <section className="card space-y-4" aria-label="Google Places" data-testid="integration-google-places-card">
      <div className="flex items-center justify-between">
        <p className="font-semibold">Google Places</p>
        <p className="text-sm text-kairikos-muted" data-testid="integration-google-places-status">
          {status.configured ? `•••• ${status.lastFour} — guardada ${formatDate(status.savedAt)}` : 'Sin configurar'}
        </p>
      </div>
      <p className="text-xs text-kairikos-muted">
        Usada por Prospección con IA para buscar negocios con la API de Google Places (New).
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="password"
          className="input flex-1"
          placeholder="AIza..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          data-testid="integration-google-places-input"
          autoComplete="off"
        />
        <button
          type="button"
          className="btn-primary"
          disabled={!apiKey.trim() || saving}
          onClick={save}
          data-testid="integration-google-places-save"
        >
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
      {error ? (
        <p className="text-sm text-kairikos-danger" data-testid="integration-google-places-error">
          {error}
        </p>
      ) : null}
      {saved && !error ? (
        <p className="text-sm text-kairikos-success" data-testid="integration-google-places-saved">
          Guardado.
        </p>
      ) : null}
    </section>
  );
}
