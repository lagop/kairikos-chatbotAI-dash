'use client';

import { useState } from 'react';

export interface TotpStepUpModalProps {
  onCancel: () => void;
  /** Called once /api/operator/totp/verify confirms the code. The caller
   *  is responsible for retrying the original mutation. */
  onVerified: () => void;
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `error_${res.status}`;
  } catch {
    return `error_${res.status}`;
  }
}

/**
 * Step-up confirmation for the two most sensitive admin actions (saving a
 * Stripe key, confirming a price change) — see src/lib/operator-totp-stepup.ts.
 * Structural clone of OperatorEditor.tsx's ConfirmModal, with a 6-digit
 * code input instead of a yes/no confirmation.
 */
export function TotpStepUpModal({ onCancel, onVerified }: TotpStepUpModalProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/totp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        setError(await safeReadError(res));
        return;
      }
      onVerified();
    } catch {
      setError('network_error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="totp-stepup-title"
      aria-describedby="totp-stepup-desc"
      data-testid="totp-stepup-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-kairikos-bg/80 p-4"
    >
      <div className="card w-full max-w-md">
        <h3 id="totp-stepup-title" className="text-lg font-semibold">
          Verificación en dos pasos
        </h3>
        <p id="totp-stepup-desc" className="mt-2 text-sm text-kairikos-muted">
          Esta acción puede crear cargos reales en Stripe. Confirma con el código de tu app autenticadora.
        </p>

        {error === 'totp_not_enrolled' ? (
          <p className="mt-3 text-sm text-kairikos-danger" data-testid="totp-stepup-error">
            Todavía no activaste la verificación en dos pasos.{' '}
            <a href="/admin/portal/settings/security" className="underline">
              Activarla ahora
            </a>
            .
          </p>
        ) : (
          <div className="mt-4">
            <label htmlFor="totp-stepup-code" className="label">
              Código de 6 dígitos
            </label>
            <input
              id="totp-stepup-code"
              type="text"
              inputMode="numeric"
              maxLength={6}
              autoFocus
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              data-testid="totp-stepup-code-input"
            />
            {error ? (
              <p role="alert" className="mt-2 text-sm text-kairikos-danger" data-testid="totp-stepup-error">
                {error === 'invalid_code' ? 'Código incorrecto — inténtalo de nuevo.' : 'No se pudo verificar el código.'}
              </p>
            ) : null}
          </div>
        )}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            className="btn-ghost"
            data-testid="totp-stepup-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="btn-primary"
            data-testid="totp-stepup-confirm"
            onClick={submit}
            disabled={busy || code.length !== 6}
          >
            {busy ? 'Verificando…' : 'Confirmar'}
          </button>
        </div>
      </div>
    </div>
  );
}
