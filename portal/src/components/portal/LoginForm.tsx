'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';

export function LoginForm() {
  const params = useSearchParams();
  const errorCode = params.get('error');
  const id = useId();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  const errorMessage =
    errorCode === 'CredentialsSignin' || errorCode === 'AccessDenied'
      ? 'Email o contraseña incorrectos.'
      : errorCode === 'Configuration'
        ? 'Error de configuración del servidor. Avisa al equipo de soporte.'
        : clientError;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setClientError(null);

    if (!email || !email.includes('@')) {
      setClientError('Introduce un email válido.');
      return;
    }
    if (!password) {
      setClientError('Introduce tu contraseña.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await signIn('portal-credentials', {
        email,
        password,
        redirect: false,
      });
      if (!result || result.error) {
        const code = result?.error ?? 'CredentialsSignin';
        const url = new URL(window.location.href);
        url.searchParams.set('error', code);
        window.location.href = url.toString();
        return;
      }
      // Redirect to portal home on success
      window.location.href = '/portal';
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div>
        <label htmlFor={`${id}-email`} className="label">
          Email
        </label>
        <input
          id={`${id}-email`}
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
      <div>
        <label htmlFor={`${id}-password`} className="label">
          Contraseña
        </label>
        <input
          id={`${id}-password`}
          name="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="input"
        />
      </div>
      {errorMessage ? (
        <p
          role="alert"
          data-testid="error-message"
          className="text-sm text-kairikos-danger"
        >
          {errorMessage}
        </p>
      ) : null}
      <button type="submit" className="btn-primary w-full" disabled={submitting}>
        {submitting ? 'Entrando…' : 'Iniciar sesión'}
      </button>
      <p className="text-xs text-kairikos-muted">
        ¿Problemas para acceder? Escríbenos a{' '}
        <a className="underline" href="mailto:hola@kairikos.com">
          hola@kairikos.com
        </a>
        .
      </p>
    </form>
  );
}
