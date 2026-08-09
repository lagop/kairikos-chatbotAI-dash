'use client';

import { useSearchParams } from 'next/navigation';
import { useState } from 'react';

export default function SetupPasswordPage() {
  const params = useSearchParams();
  const email = params.get('email') ?? '';
  // KAIA-13282 — `?token=...` is required by the secure (KAIA-11500)
  // /api/portal/setup-password flow. The link the operator-driven
  // PATCH endpoint emails now includes the token; the legacy
  // send-setup-email route does not, and that flow is broken
  // separately (see KAIA-13282 — only the email-change branch of
  // this task emits the token). We forward whatever we got to the
  // API; if the token is missing, the API responds with
  // `invalid_or_expired_token` and the page renders the generic
  // "no se ha podido configurar la contraseña" message.
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!email) {
      setError('No se ha proporcionado el email. Usa el enlace del correo de invitación.');
      return;
    }
    if (!token) {
      setError('El enlace no es válido. Solicita un nuevo correo de activación al equipo de Kairikos.');
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
      const res = await fetch('/api/portal/setup-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.error === 'password_already_set') {
          setError('Esta cuenta ya tiene una contraseña configurada.');
        } else if (data.error === 'invalid_or_expired_token') {
          setError('El enlace ha caducado o ya se ha usado. Solicita uno nuevo.');
        } else {
          setError('No se ha podido configurar la contraseña. Inténtalo de nuevo.');
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
            Portal Kairikos
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">
            Contraseña configurada
          </h1>
          <p className="mt-3 text-sm text-kairikos-muted">
            Tu contraseña se ha creado correctamente. Ya puedes iniciar sesión con tu email y contraseña.
          </p>
          <a href="/portal/login" className="btn-primary mt-6 inline-block">
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
            Portal Kairikos
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Crea tu contraseña
          </h1>
          <p className="mt-2 text-sm text-kairikos-muted">
            {email
              ? `Configura la contraseña para ${email}.`
              : 'Configura la contraseña para tu cuenta.'}
          </p>
        </header>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="password" className="label">
              Contraseña
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
              placeholder="Repite la contraseña"
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
            <a href="/portal/login" className="underline">
              Volver al inicio de sesión
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
