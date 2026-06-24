'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

export default function AdminResetPasswordForm() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const email = params.get('email') ?? '';
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!token) {
      setError('El enlace de restablecimiento no es válido o ha expirado.');
      return;
    }
    if (!email) {
      setError('No se ha proporcionado el email. Usa el enlace del correo.');
      return;
    }
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== confirmPassword) {
      setError('Las contraseñas no coinciden.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/portal/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === 'invalid_or_expired_token') {
          setError('El enlace ha expirado o ya se ha utilizado. Solicita uno nuevo.');
        } else {
          setError('No se ha podido restablecer la contraseña. Inténtalo de nuevo.');
        }
        return;
      }
      setSuccess(true);
    } catch {
      setError('Error de conexión. Inténtalo de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10 sm:px-6">
        <div className="card text-center">
          <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">
            Soporte Kairikos
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Contraseña restablecida
          </h1>
          <p className="mt-3 text-sm text-kairikos-muted">
            Tu contraseña se ha cambiado correctamente. Ya puedes iniciar sesión.
          </p>
          <a href="/admin/login" className="btn-primary mt-6 inline-block">
            Iniciar sesión
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10 sm:px-6">
      <div className="card">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">
            Soporte Kairikos
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Nueva contraseña
          </h1>
          <p className="mt-2 text-sm text-kairikos-muted">
            Introduce tu nueva contraseña.
          </p>
        </header>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="password" className="label">
              Nueva contraseña
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mínimo 8 caracteres"
              className="input"
              data-testid="password-input"
              minLength={8}
            />
          </div>
          <div>
            <label htmlFor="confirm-password" className="label">
              Repetir contraseña
            </label>
            <input
              id="confirm-password"
              name="confirm-password"
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Repite la nueva contraseña"
              className="input"
            />
          </div>
          {error ? (
            <p role="alert" data-testid="signin-error" className="text-sm text-kairikos-danger">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn-primary w-full" disabled={submitting}>
            {submitting ? 'Guardando…' : 'Guardar contraseña'}
          </button>
          <p className="text-center text-xs text-kairikos-muted">
            <a href="/admin/login" className="underline">
              Volver al inicio de sesión
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
