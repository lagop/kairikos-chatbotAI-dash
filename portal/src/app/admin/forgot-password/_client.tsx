'use client';

import { useState } from 'react';

export default function AdminForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!email || !email.includes('@')) {
      setError('Introduce un email válido.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/operator/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError('No se ha podido enviar el correo. Inténtalo de nuevo.');
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
            Revisa tu correo
          </h1>
          <p className="mt-3 text-sm text-kairikos-muted">
            Si el email existe en nuestro sistema, recibirás un enlace para restablecer tu contraseña.
            Consulta también la carpeta de spam.
          </p>
          <a href="/admin/login" className="btn-primary mt-6 inline-block">
            Volver al inicio de sesión
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
            Restablecer contraseña
          </h1>
          <p className="mt-2 text-sm text-kairikos-muted">
            Introduce tu email y te enviaremos un enlace para restablecer tu contraseña.
          </p>
        </header>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="email" className="label">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@negocio.es"
              className="input"
            />
          </div>
          {error ? (
            <p role="alert" data-testid="signin-error" className="text-sm text-kairikos-danger">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn-primary w-full" disabled={submitting}>
            {submitting ? 'Enviando…' : 'Enviar enlace'}
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
