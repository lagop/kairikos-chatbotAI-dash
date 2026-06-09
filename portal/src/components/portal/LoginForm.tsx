'use client';

import { useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';

export function LoginForm() {
  const params = useSearchParams();
  const sent = params.get('sent') === '1';
  const initialEmail = params.get('email') ?? '';
  const errorCode = params.get('error');
  const token = params.get('token');
  const id = useId();

  const expired = Boolean(token);
  const [email, setEmail] = useState(initialEmail);

  if (expired) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-kairikos-warning/40 bg-kairikos-warning/10 p-4 text-sm text-kairikos-warning"
        data-testid="error-message"
      >
        El enlace ha expirado o ya no es válido (enlace expirado, link expired). Pide uno nuevo
        introduciendo tu email abajo.
      </div>
    );
  }

  const errorMessage =
    errorCode === 'email' || errorCode === 'formato'
      ? 'Introduce un email con formato válido (formato válido).'
      : errorCode === 'otp'
        ? 'No hemos podido enviar el enlace. Inténtalo de nuevo en unos minutos.'
        : errorCode === 'callback'
          ? 'El enlace ha caducado o ya se ha usado. Pide uno nuevo.'
          : null;

  if (sent) {
    return (
      <div
        role="status"
        className="rounded-xl border border-kairikos-success/30 bg-kairikos-success/10 p-4 text-sm text-kairikos-success"
        data-testid="magic-link-sent"
      >
        <p>
          <strong>Revisa tu correo</strong> (check your email) — te hemos enviado un enlace mágico a{' '}
          <strong>{initialEmail || 'tu email'}</strong>. Ábrelo en este mismo navegador para acceder al
          portal. El enlace caduca en unos minutos.
        </p>
      </div>
    );
  }

  return (
    <form action="/api/portal/login" method="post" className="space-y-4" noValidate>
      <div>
        <label htmlFor={`${id}-email`} className="label">
          Tu email de cliente
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
      {errorMessage ? (
        <p
          role="alert"
          data-testid="error-message"
          className="text-sm text-kairikos-danger"
        >
          {errorMessage}
        </p>
      ) : null}
      <button type="submit" className="btn-primary w-full">
        Enviar enlace mágico
      </button>
      <p className="text-xs text-kairikos-muted">
        Sólo los clientes con un chatbot Kairikos activo pueden acceder. Si no lo eres, te mostraremos una
        página informativa.
      </p>
    </form>
  );
}
