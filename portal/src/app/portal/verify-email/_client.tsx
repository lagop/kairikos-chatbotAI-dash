'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useId, useState } from 'react';
import { continueToPurchase } from '@/components/public/continue-to-purchase';

// Revisión de seguridad del 22/09/2026 — verificar antes de pagar. Para un
// alta de autoservicio, confirmar el email es lo que DESBLOQUEA la cuenta
// (lib/pending-signup.ts). El enlace lleva el producto elegido en el
// formulario (`product`, y `quote=1` si es una web a medida), así que en
// cuanto se confirma se pide la contraseña y se sigue sin rodeos: entrar →
// pagar o pedir presupuesto. Sin `product` (un enlace antiguo, o una
// cuenta creada por un operador), solo se confirma.

type Status = 'verifying' | 'success' | 'error';

export default function VerifyEmailForm() {
  const params = useSearchParams();
  const email = params.get('email') ?? '';
  const token = params.get('token') ?? '';
  const productId = params.get('product') ?? '';
  const requiresQuote = params.get('quote') === '1';
  const [status, setStatus] = useState<Status>('verifying');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!email || !token) {
      setStatus('error');
      setError('El enlace no es válido. Solicita uno nuevo desde tu cuenta.');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/public/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, token }),
        });
        if (cancelled) return;
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setStatus('error');
          setError(
            data?.error === 'invalid_or_expired_token'
              ? 'El enlace ha caducado o ya se ha usado. Si ya lo usaste, entra con tu email y contraseña; si no, restablece la contraseña para activar la cuenta.'
              : 'No se ha podido confirmar el email. Inténtalo de nuevo.',
          );
          return;
        }
        setStatus('success');
      } catch {
        if (!cancelled) {
          setStatus('error');
          setError('Error de conexión. Inténtalo de nuevo.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [email, token]);

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10 sm:px-6">
      <div className="card text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">Portal Kairikos</p>
        {status === 'verifying' ? (
          <>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Confirmando tu email…</h1>
          </>
        ) : status === 'success' ? (
          productId ? (
            <ContinueAfterVerify email={email} productId={productId} requiresQuote={requiresQuote} />
          ) : (
            <>
              <h1 className="mt-2 text-2xl font-semibold tracking-tight">Email confirmado</h1>
              <p className="mt-3 text-sm text-kairikos-muted">Tu cuenta está activa. Ya puedes entrar con tu email y contraseña.</p>
              <a href="/portal/login" className="btn-primary mt-6 inline-block">
                Ir al portal
              </a>
            </>
          )
        ) : (
          <>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">No se pudo confirmar</h1>
            <p role="alert" data-testid="verify-email-error" className="mt-3 text-sm text-kairikos-danger">
              {error}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <a href="/portal/login" className="btn-primary inline-block">
                Entrar
              </a>
              <a href="/portal/forgot-password" className="btn-ghost inline-block">
                Restablecer contraseña
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ContinueAfterVerify({
  email,
  productId,
  requiresQuote,
}: {
  email: string;
  productId: string;
  requiresQuote: boolean;
}) {
  const id = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const signInResult = await signIn('portal-credentials', { email, password, redirect: false });
      if (!signInResult || signInResult.error) {
        setError('La contraseña no coincide con la que elegiste al crear la cuenta.');
        setBusy(false);
        return;
      }
      const next = await continueToPurchase(productId, requiresQuote);
      if (!next.ok) {
        setError(next.message);
        setBusy(false);
        return;
      }
      window.location.href = next.redirectTo;
    } catch (err) {
      setError(`Error de red: ${err instanceof Error ? err.message : 'desconocido'}`);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="text-left" data-testid="verify-email-continue">
      <h1 className="mt-2 text-center text-2xl font-semibold tracking-tight">Email confirmado</h1>
      <p className="mt-3 text-center text-sm text-kairikos-muted">
        Tu cuenta está activa. Introduce la contraseña que elegiste para{' '}
        {requiresQuote ? 'enviar tu solicitud de presupuesto' : 'continuar con el pago'}.
      </p>
      <label htmlFor={`${id}-password`} className="label mt-6">
        Contraseña de {email}
      </label>
      <input
        id={`${id}-password`}
        type="password"
        className="input"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        autoFocus
      />
      {error ? (
        <p role="alert" className="mt-3 text-sm text-kairikos-danger">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn-primary mt-4 w-full" disabled={busy || password.length === 0}>
        {busy ? 'Un momento…' : requiresQuote ? 'Entrar y solicitar presupuesto' : 'Entrar y pagar'}
      </button>
      <p className="mt-3 text-center text-xs text-kairikos-muted">
        ¿No la recuerdas? <a className="underline" href="/portal/forgot-password">Restablécela</a>.
      </p>
    </form>
  );
}
