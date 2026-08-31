'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TotpStepUpModal } from './TotpStepUpModal';

// =============================================================================
// WP-XX — save/rotate the operator's Twilio credential pair, moving it
// off TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN-on-the-VPS-.env-only. Same
// step-up + verify-before-save shape as StripeCatalogSettingsPanel, with
// no test/live split (Twilio has no equivalent) and two fields instead
// of one (accountSid pairs with authToken for Basic Auth).
// =============================================================================

export interface TwilioCredentialStatus {
  configured: boolean;
  accountSid: string | null;
  authTokenLastFour: string | null;
  savedAt: string | null;
  bundleSid: string | null;
  addressSid: string | null;
}

type ToastKind = 'success' | 'error';
interface ToastState {
  kind: ToastKind;
  message: string;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Datos inválidos.',
  invalid_twilio_credentials: 'Twilio rechazó esas credenciales — revisa el Account SID y el Auth Token.',
  service_unavailable: 'No disponible en este momento.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  internal_error: 'Algo falló en el servidor. Si persiste, contacta con el equipo técnico.',
};

const REGULATORY_ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Rellena los dos campos.',
  service_unavailable: 'No disponible en este momento.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
  internal_error: 'Algo falló en el servidor. Si persiste, contacta con el equipo técnico.',
};

function errorLabel(code: string | undefined): string {
  return (code && ERROR_LABEL[code]) || 'No se pudo completar la operación.';
}

function regulatoryErrorLabel(code: string | undefined): string {
  return (code && REGULATORY_ERROR_LABEL[code]) || 'No se pudo completar la operación.';
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

export function TwilioCredentialsPanel({ initialStatus }: { initialStatus: TwilioCredentialStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busy, setBusy] = useState(false);
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [stepUp, setStepUp] = useState<StepUpPending | null>(null);
  const [bundleSid, setBundleSid] = useState(initialStatus.bundleSid ?? '');
  const [addressSid, setAddressSid] = useState(initialStatus.addressSid ?? '');
  const [regulatoryBusy, setRegulatoryBusy] = useState(false);

  const showToast = (next: ToastState) => {
    setToast(next);
    setTimeout(() => setToast((current) => (current === next ? null : current)), 5000);
  };

  /** Same resolve-with-cancelled-flag shape as StripeCatalogSettingsPanel's
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
    if (!accountSid || !authToken) return;
    await requestWithStepUp(
      () =>
        fetch('/api/admin/portal/settings/twilio/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountSid, authToken }),
        }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          showToast({ kind: 'success', message: 'Credenciales de Twilio guardadas.' });
          setAccountSid('');
          setAuthToken('');
          setStatus((s) => ({
            ...s,
            configured: true,
            accountSid: body.accountSid as string,
            authTokenLastFour: body.lastFour as string,
            savedAt: new Date().toISOString(),
          }));
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  async function saveRegulatoryIds() {
    if (!bundleSid || !addressSid) return;
    setRegulatoryBusy(true);
    try {
      const res = await fetch('/api/admin/portal/settings/twilio/regulatory-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundleSid, addressSid }),
      });
      const body = await safeJson(res);
      if (res.ok) {
        showToast({ kind: 'success', message: 'Identificadores regulatorios guardados.' });
        setStatus((s) => ({ ...s, bundleSid, addressSid }));
        router.refresh();
      } else {
        showToast({ kind: 'error', message: regulatoryErrorLabel(body.error as string) });
      }
    } finally {
      setRegulatoryBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {toast ? (
        <div
          role="status"
          data-testid="twilio-settings-toast"
          className={`rounded-xl border px-4 py-3 text-sm ${
            toast.kind === 'success'
              ? 'border-kairikos-success/40 bg-kairikos-success/10 text-kairikos-success'
              : 'border-kairikos-danger/40 bg-kairikos-danger/10 text-kairikos-danger'
          }`}
        >
          {toast.message}
        </div>
      ) : null}

      <section className="card space-y-4" aria-label="Credenciales de Twilio">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Credenciales</h2>
          <p className="text-sm text-kairikos-muted" data-testid="twilio-credential-status">
            {status.configured
              ? `${status.accountSid} · •••• ${status.authTokenLastFour} — guardadas ${formatDate(status.savedAt)}`
              : 'Sin configurar'}
          </p>
        </div>

        <div className="space-y-2">
          <label className="label" htmlFor="twilio-account-sid">
            Account SID
          </label>
          <input
            id="twilio-account-sid"
            type="text"
            className="input"
            placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            value={accountSid}
            onChange={(e) => setAccountSid(e.target.value)}
            data-testid="twilio-credential-account-sid"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <label className="label" htmlFor="twilio-auth-token">
            Auth Token
          </label>
          <input
            id="twilio-auth-token"
            type="password"
            className="input"
            placeholder="Auth Token"
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            data-testid="twilio-credential-auth-token"
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={!accountSid || !authToken || busy}
          onClick={() => saveCredential()}
          data-testid="twilio-credential-save"
        >
          {busy ? 'Guardando…' : 'Guardar'}
        </button>
      </section>

      <section className="card space-y-4" aria-label="Identificadores regulatorios">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Numeración española (Bundle / Address)</h2>
          <p className="text-sm text-kairikos-muted" data-testid="twilio-regulatory-status">
            {status.bundleSid && status.addressSid ? `${status.bundleSid} · ${status.addressSid}` : 'Sin configurar'}
          </p>
        </div>
        <p className="text-sm text-kairikos-muted">
          No son secretos — se registran una sola vez en la consola de Twilio para todo el negocio, no por cliente.
        </p>
        <div className="space-y-2">
          <label className="label" htmlFor="twilio-bundle-sid">
            Bundle SID
          </label>
          <input
            id="twilio-bundle-sid"
            type="text"
            className="input"
            placeholder="BUxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            value={bundleSid}
            onChange={(e) => setBundleSid(e.target.value)}
            data-testid="twilio-regulatory-bundle-sid"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <label className="label" htmlFor="twilio-address-sid">
            Address SID
          </label>
          <input
            id="twilio-address-sid"
            type="text"
            className="input"
            placeholder="ADxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            value={addressSid}
            onChange={(e) => setAddressSid(e.target.value)}
            data-testid="twilio-regulatory-address-sid"
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={!bundleSid || !addressSid || regulatoryBusy}
          onClick={() => saveRegulatoryIds()}
          data-testid="twilio-regulatory-save"
        >
          {regulatoryBusy ? 'Guardando…' : 'Guardar'}
        </button>
      </section>

      {stepUp ? <TotpStepUpModal onCancel={stepUp.onCancel} onVerified={stepUp.onVerified} /> : null}
    </div>
  );
}
