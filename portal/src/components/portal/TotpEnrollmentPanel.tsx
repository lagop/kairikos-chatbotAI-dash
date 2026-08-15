'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Step = 'idle' | 'scan' | 'recovery-codes';

interface EnrollScanResponse {
  uri: string;
  step: 'scan';
}

interface EnrollFinalizeResponse {
  recoveryCodes: string[];
  message: string;
}

function extractSecret(uri: string): string | null {
  try {
    return new URL(uri).searchParams.get('secret');
  } catch {
    return null;
  }
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `error_${res.status}`;
  } catch {
    return `error_${res.status}`;
  }
}

export function TotpEnrollmentPanel({ initiallyEnrolled }: { initiallyEnrolled: boolean }) {
  const router = useRouter();
  const [enrolled, setEnrolled] = useState(initiallyEnrolled);
  const [step, setStep] = useState<Step>('idle');
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startEnrollment() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/totp/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        setError(await safeReadError(res));
        return;
      }
      const body = (await res.json()) as EnrollScanResponse;
      const parsedSecret = extractSecret(body.uri);
      setSecret(parsedSecret);
      setStep('scan');
    } catch {
      setError('network_error');
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrollment() {
    if (code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/operator/totp/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        setError(await safeReadError(res));
        return;
      }
      const body = (await res.json()) as EnrollFinalizeResponse;
      setRecoveryCodes(body.recoveryCodes);
      setStep('recovery-codes');
      setEnrolled(true);
    } catch {
      setError('network_error');
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    setStep('idle');
    setSecret(null);
    setCode('');
    setRecoveryCodes([]);
    router.refresh();
  }

  if (enrolled && step !== 'recovery-codes') {
    return (
      <div className="card" data-testid="totp-enrollment-panel">
        <h2 className="text-lg font-semibold">Verificación en dos pasos</h2>
        <p
          className="mt-2 inline-flex items-center gap-2 rounded-full border border-kairikos-success/40 bg-kairikos-success/10 px-3 py-1 text-sm text-kairikos-success"
          data-testid="totp-enrolled-badge"
        >
          Activada
        </p>
      </div>
    );
  }

  return (
    <div className="card" data-testid="totp-enrollment-panel">
      <h2 className="text-lg font-semibold">Verificación en dos pasos</h2>
      <p className="mt-1 text-sm text-kairikos-muted">
        Necesaria para guardar credenciales de Stripe o cambiar precios del catálogo.
      </p>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-kairikos-danger" data-testid="totp-enroll-error">
          {errorLabel(error)}
        </p>
      ) : null}

      {step === 'idle' ? (
        <button
          type="button"
          className="btn-primary mt-4"
          onClick={startEnrollment}
          disabled={busy}
          data-testid="totp-enroll-start"
        >
          {busy ? 'Generando…' : 'Activar verificación en dos pasos'}
        </button>
      ) : null}

      {step === 'scan' ? (
        <div className="mt-4 space-y-3">
          <div>
            <p className="label">Código secreto</p>
            <p
              className="mt-1 select-all break-all rounded-lg border border-kairikos-border bg-kairikos-surface2 px-3 py-2 font-mono text-sm"
              data-testid="totp-secret"
            >
              {secret ?? '—'}
            </p>
            <p className="mt-1 text-xs text-kairikos-muted">
              Copia este código en tu app autenticadora (Google Authenticator, 1Password, etc.), luego escribe el
              código de 6 dígitos que genere.
            </p>
          </div>
          <div>
            <label htmlFor="totp-code" className="label">
              Código de 6 dígitos
            </label>
            <input
              id="totp-code"
              type="text"
              inputMode="numeric"
              maxLength={6}
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              data-testid="totp-code-input"
            />
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={confirmEnrollment}
            disabled={busy || code.length !== 6}
            data-testid="totp-enroll-confirm"
          >
            {busy ? 'Verificando…' : 'Confirmar'}
          </button>
        </div>
      ) : null}

      {step === 'recovery-codes' ? (
        <div className="mt-4 space-y-3">
          <p className="text-sm font-semibold text-kairikos-success">Verificación en dos pasos activada.</p>
          <p className="text-sm text-kairikos-muted">
            Guarda estos códigos de recuperación en un lugar seguro — no se van a volver a mostrar.
          </p>
          <ul
            className="grid grid-cols-2 gap-2 rounded-lg border border-kairikos-border bg-kairikos-surface2 p-3 font-mono text-sm"
            data-testid="totp-recovery-codes"
          >
            {recoveryCodes.map((rc) => (
              <li key={rc}>{rc}</li>
            ))}
          </ul>
          <button type="button" className="btn-primary" onClick={finish} data-testid="totp-enroll-done">
            Ya los guardé
          </button>
        </div>
      ) : null}
    </div>
  );
}

function errorLabel(code: string): string {
  switch (code) {
    case 'invalid_code':
      return 'Código incorrecto — inténtalo de nuevo.';
    case 'totp_already_enrolled':
      return 'La verificación en dos pasos ya estaba activada.';
    case 'enrollment_not_started':
      return 'No se pudo verificar — volvé a empezar el proceso.';
    case 'error_401':
      return 'Tu sesión expiró — vuelve a iniciar sesión.';
    case 'network_error':
      return 'No se pudo conectar — inténtalo de nuevo.';
    default:
      return 'No se pudo completar la operación.';
  }
}
