'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TotpStepUpModal } from './TotpStepUpModal';

// =============================================================================
// Save/rotate the operator's Meta app credentials, moving them off
// META_APP_ID/META_APP_SECRET/META_CONFIG_ID/META_COEXISTENCE_CONFIG_ID
// on-the-VPS-.env-only. Same step-up + verify-before-save shape as
// TwilioCredentialsPanel, with four fields instead of two — appId pairs
// with appSecret (Meta's Basic OAuth-client pair); configId and
// coexistenceConfigId are two SEPARATE Embedded Signup Configuration
// ids (which flow a signup popup opens in), not credentials.
// =============================================================================

export interface MetaCredentialStatus {
  configured: boolean;
  appId: string | null;
  appSecretLastFour: string | null;
  savedAt: string | null;
  configId: string | null;
  coexistenceConfigId: string | null;
}

type ToastKind = 'success' | 'error';
interface ToastState {
  kind: ToastKind;
  message: string;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Datos inválidos.',
  invalid_meta_credentials: 'Meta rechazó esas credenciales — revisa el App ID y el App Secret.',
  service_unavailable: 'No disponible en este momento.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  internal_error: 'Algo falló en el servidor. Si persiste, contacta con el equipo técnico.',
};

const CONFIG_ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Rellena los dos campos.',
  service_unavailable: 'No disponible en este momento.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  internal_error: 'Algo falló en el servidor. Si persiste, contacta con el equipo técnico.',
};

function errorLabel(code: string | undefined): string {
  return (code && ERROR_LABEL[code]) || 'No se pudo completar la operación.';
}

function configErrorLabel(code: string | undefined): string {
  return (code && CONFIG_ERROR_LABEL[code]) || 'No se pudo completar la operación.';
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

interface StepUpPending {
  onVerified: () => void;
  onCancel: () => void;
}

export function MetaCredentialsPanel({ initialStatus }: { initialStatus: MetaCredentialStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busy, setBusy] = useState(false);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [stepUp, setStepUp] = useState<StepUpPending | null>(null);
  const [configId, setConfigId] = useState(initialStatus.configId ?? '');
  const [coexistenceConfigId, setCoexistenceConfigId] = useState(initialStatus.coexistenceConfigId ?? '');
  const [configBusy, setConfigBusy] = useState(false);

  const showToast = (next: ToastState) => {
    setToast(next);
    setTimeout(() => setToast((current) => (current === next ? null : current)), 5000);
  };

  /** Same resolve-with-cancelled-flag shape as TwilioCredentialsPanel's
   *  requestWithStepUp — see that component for the full reasoning. */
  async function requestWithStepUp(
    doFetch: () => Promise<Response>,
    onDone: (res: Response) => Promise<void> | void,
  ): Promise<{ cancelled: boolean }> {
    setBusy(true);
    let res: Response;
    try {
      res = await doFetch();
    } finally {
      setBusy(false);
    }
    if (res.status === 403) {
      const body = await res.clone().json().catch(() => ({}));
      if ((body as { error?: string }).error === 'totp_step_up_required') {
        return new Promise<{ cancelled: boolean }>((resolve) => {
          setStepUp({
            onVerified: () => {
              setStepUp(null);
              void requestWithStepUp(doFetch, onDone).then(resolve);
            },
            onCancel: () => {
              setStepUp(null);
              resolve({ cancelled: true });
            },
          });
        });
      }
    }
    await onDone(res);
    return { cancelled: false };
  }

  async function saveCredential() {
    if (!appId || !appSecret) return;
    await requestWithStepUp(
      () =>
        fetch('/api/admin/portal/settings/meta/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId, appSecret }),
        }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          showToast({ kind: 'success', message: 'Credenciales de Meta guardadas.' });
          setAppId('');
          setAppSecret('');
          setStatus((s) => ({
            ...s,
            configured: true,
            appId: body.appId as string,
            appSecretLastFour: body.lastFour as string,
            savedAt: new Date().toISOString(),
          }));
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  async function saveConfigIds() {
    if (!configId || !coexistenceConfigId) return;
    setConfigBusy(true);
    try {
      const res = await fetch('/api/admin/portal/settings/meta/config-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configId, coexistenceConfigId }),
      });
      const body = await safeJson(res);
      if (res.ok) {
        showToast({ kind: 'success', message: 'Configuraciones guardadas.' });
        setStatus((s) => ({ ...s, configId, coexistenceConfigId }));
        router.refresh();
      } else {
        showToast({ kind: 'error', message: configErrorLabel(body.error as string) });
      }
    } finally {
      setConfigBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {toast ? (
        <div
          role="status"
          data-testid="meta-settings-toast"
          className={`rounded-xl border px-4 py-3 text-sm ${
            toast.kind === 'success'
              ? 'border-kairikos-success/40 bg-kairikos-success/10 text-kairikos-success'
              : 'border-kairikos-danger/40 bg-kairikos-danger/10 text-kairikos-danger'
          }`}
        >
          {toast.message}
        </div>
      ) : null}

      <section className="card space-y-4" aria-label="Credenciales de Meta">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Credenciales de la app</h2>
          <p className="text-sm text-kairikos-muted" data-testid="meta-credential-status">
            {status.configured
              ? `${status.appId} · •••• ${status.appSecretLastFour} — guardadas ${formatDate(status.savedAt)}`
              : 'Sin configurar'}
          </p>
        </div>

        <div className="space-y-2">
          <label className="label" htmlFor="meta-app-id">
            App ID
          </label>
          <input
            id="meta-app-id"
            type="text"
            className="input"
            placeholder="App ID de Meta for Developers"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            data-testid="meta-credential-app-id"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <label className="label" htmlFor="meta-app-secret">
            App Secret
          </label>
          <input
            id="meta-app-secret"
            type="password"
            className="input"
            placeholder="App Secret"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            data-testid="meta-credential-app-secret"
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={!appId || !appSecret || busy}
          onClick={() => saveCredential()}
          data-testid="meta-credential-save"
        >
          {busy ? 'Guardando…' : 'Guardar'}
        </button>
      </section>

      <section className="card space-y-4" aria-label="Configuraciones de Embedded Signup">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Configuraciones de Embedded Signup</h2>
          <p className="text-sm text-kairikos-muted" data-testid="meta-config-status">
            {status.configId && status.coexistenceConfigId ? `${status.configId} · ${status.coexistenceConfigId}` : 'Sin configurar'}
          </p>
        </div>
        <p className="text-sm text-kairikos-muted">
          No son secretos — son los <code>config_id</code> del popup de Meta, uno por flujo. El primero abre el flujo
          normal de canales del chatbot; el segundo abre el flujo de Coexistence de recall.
        </p>
        <div className="space-y-2">
          <label className="label" htmlFor="meta-config-id">
            Config ID (canales del chatbot)
          </label>
          <input
            id="meta-config-id"
            type="text"
            className="input"
            placeholder="config_id"
            value={configId}
            onChange={(e) => setConfigId(e.target.value)}
            data-testid="meta-config-id-input"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <label className="label" htmlFor="meta-coexistence-config-id">
            Config ID (Coexistence, recall)
          </label>
          <input
            id="meta-coexistence-config-id"
            type="text"
            className="input"
            placeholder="config_id"
            value={coexistenceConfigId}
            onChange={(e) => setCoexistenceConfigId(e.target.value)}
            data-testid="meta-coexistence-config-id-input"
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={!configId || !coexistenceConfigId || configBusy}
          onClick={() => saveConfigIds()}
          data-testid="meta-config-save"
        >
          {configBusy ? 'Guardando…' : 'Guardar'}
        </button>
      </section>

      {stepUp ? <TotpStepUpModal onCancel={stepUp.onCancel} onVerified={stepUp.onVerified} /> : null}
    </div>
  );
}
