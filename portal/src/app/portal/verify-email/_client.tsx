'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

type Status = 'verifying' | 'success' | 'error';

export default function VerifyEmailForm() {
  const params = useSearchParams();
  const email = params.get('email') ?? '';
  const token = params.get('token') ?? '';
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
              ? 'El enlace ha caducado o ya se ha usado. Solicita uno nuevo.'
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
          <>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">Email confirmado</h1>
            <p className="mt-3 text-sm text-kairikos-muted">Tu cuenta ya funcionaba antes de este paso — solo confirmábamos que el correo es tuyo.</p>
            <a href="/portal" className="btn-primary mt-6 inline-block">
              Ir al portal
            </a>
          </>
        ) : (
          <>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight">No se pudo confirmar</h1>
            <p role="alert" data-testid="verify-email-error" className="mt-3 text-sm text-kairikos-danger">
              {error}
            </p>
            <a href="/portal/login" className="btn-primary mt-6 inline-block">
              Ir al portal
            </a>
          </>
        )}
      </div>
    </div>
  );
}
