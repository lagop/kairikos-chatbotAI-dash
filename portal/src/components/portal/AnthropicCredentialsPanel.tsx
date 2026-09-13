'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TotpStepUpModal } from './TotpStepUpModal';

// =============================================================================
// Save/rotate the operator's Anthropic credential, moving it off
// ANTHROPIC_API_KEY-on-the-VPS-.env-only. Same step-up + verify-before-save
// shape as TwilioCredentialsPanel, single section instead of two: baseUrl
// and model are entered in the same form as the key, not a separate
// ceremony the way Twilio's regulatory ids are.
// =============================================================================

export interface AnthropicCredentialStatus {
  configured: boolean;
  apiKeyLastFour: string | null;
  savedAt: string | null;
  baseUrl: string | null;
  model: string | null;
}

type ToastKind = 'success' | 'error';
interface ToastState {
  kind: ToastKind;
  message: string;
}

const ERROR_LABEL: Record<string, string> = {
  invalid_body: 'Datos inválidos.',
  invalid_base_url: 'Esa URL no es válida.',
  invalid_anthropic_credentials: 'Anthropic rechazó esa clave (o el modelo/URL indicados) — revísalos.',
  service_unavailable: 'No disponible en este momento.',
  unauthorized: 'Tu sesión expiró — vuelve a iniciar sesión.',
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

interface StepUpPending {
  onVerified: () => void;
  onCancel: () => void;
}

export function AnthropicCredentialsPanel({ initialStatus }: { initialStatus: AnthropicCredentialStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState(initialStatus);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(initialStatus.baseUrl ?? '');
  const [model, setModel] = useState(initialStatus.model ?? '');
  const [stepUp, setStepUp] = useState<StepUpPending | null>(null);

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
    if (!apiKey) return;
    await requestWithStepUp(
      () =>
        fetch('/api/admin/portal/settings/anthropic/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey, baseUrl, model }),
        }),
      async (res) => {
        const body = await safeJson(res);
        if (res.ok) {
          showToast({ kind: 'success', message: 'Credencial de Anthropic guardada.' });
          setApiKey('');
          setStatus((s) => ({
            ...s,
            configured: true,
            apiKeyLastFour: body.lastFour as string,
            baseUrl: (body.baseUrl as string | null) ?? null,
            model: (body.model as string | null) ?? null,
            savedAt: new Date().toISOString(),
          }));
          router.refresh();
        } else {
          showToast({ kind: 'error', message: errorLabel(body.error as string) });
        }
      },
    );
  }

  return (
    <div className="space-y-6">
      {toast ? (
        <div
          role="status"
          data-testid="anthropic-settings-toast"
          className={`rounded-xl border px-4 py-3 text-sm ${
            toast.kind === 'success'
              ? 'border-kairikos-success/40 bg-kairikos-success/10 text-kairikos-success'
              : 'border-kairikos-danger/40 bg-kairikos-danger/10 text-kairikos-danger'
          }`}
        >
          {toast.message}
        </div>
      ) : null}

      <section className="card space-y-4" aria-label="Credencial de Anthropic">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Credencial</h2>
          <p className="text-sm text-kairikos-muted" data-testid="anthropic-credential-status">
            {status.configured ? `•••• ${status.apiKeyLastFour} — guardada ${formatDate(status.savedAt)}` : 'Sin configurar'}
          </p>
        </div>
        <p className="text-sm text-kairikos-muted">
          Una única clave alimenta todo el motor de IA del portal: las respuestas del chatbot, el clasificador de
          Captación con IA, las respuestas de reseñas, los resúmenes de conversación y la generación de contenido
          SEO. Deja el modelo y la URL en blanco para usar los valores por defecto.
        </p>

        <div className="space-y-2">
          <label className="label" htmlFor="anthropic-api-key">
            Clave de API
          </label>
          <input
            id="anthropic-api-key"
            type="password"
            className="input"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            data-testid="anthropic-credential-api-key"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <label className="label" htmlFor="anthropic-model">
            Modelo (opcional)
          </label>
          <input
            id="anthropic-model"
            type="text"
            className="input"
            placeholder="claude-haiku-4-5-20251001"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            data-testid="anthropic-credential-model"
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <label className="label" htmlFor="anthropic-base-url">
            URL de la API (opcional)
          </label>
          <input
            id="anthropic-base-url"
            type="text"
            className="input"
            placeholder="https://api.anthropic.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            data-testid="anthropic-credential-base-url"
            autoComplete="off"
          />
        </div>
        <button
          type="button"
          className="btn-primary"
          disabled={!apiKey || busy}
          onClick={() => saveCredential()}
          data-testid="anthropic-credential-save"
        >
          {busy ? 'Guardando…' : 'Guardar'}
        </button>
      </section>

      {stepUp ? <TotpStepUpModal onCancel={stepUp.onCancel} onVerified={stepUp.onVerified} /> : null}
    </div>
  );
}
