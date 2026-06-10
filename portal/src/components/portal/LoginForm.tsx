'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { useId, useState, useTransition } from 'react';

export function LoginForm() {
  const params = useSearchParams();
  const sent = params.get('sent') === '1';
  const initialEmail = params.get('email') ?? '';
  const errorCode = params.get('error');
  const crossTenant = params.get('reason') === 'cross_tenant';
  const id = useId();

  const [email, setEmail] = useState(initialEmail);
  const [submitting, setSubmitting] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const errorMessage =
    crossTenant
      ? 'Esta sesión pertenece a otro cliente. Pide un nuevo enlace con tu email.'
      : errorCode === 'AccessDenied'
        ? 'Tu cuenta no está configurada todavía. Escríbenos a hola@kairikos.com para activarla.'
        : errorCode === 'Configuration'
          ? 'El servicio de email no está configurado. Avisa al equipo de soporte.'
          : errorCode === 'Verification'
            ? 'El enlace ha caducado o ya se ha usado. Pide uno nuevo.'
            : clientError;

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
          portal. El enlace caduca en 24 horas.
        </p>
      </div>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setClientError(null);
    if (!email || !email.includes('@')) {
      setClientError('Introduce un email con formato válido.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await signIn('nodemailer', {
        email,
        redirect: false,
      });
      if (!result || result.error) {
        // Map NextAuth error codes to the same UX as the query-string path.
        const code = result?.error ?? 'default';
        startTransition(() => {
          const url = new URL(window.location.href);
          url.searchParams.set('error', code);
          url.searchParams.set('email', email);
          window.location.href = url.toString();
        });
        return;
      }
      const url = new URL(window.location.href);
      url.searchParams.set('sent', '1');
      url.searchParams.set('email', email);
      window.location.href = url.toString();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
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
      <button type="submit" className="btn-primary w-full" disabled={submitting}>
        {submitting ? 'Enviando…' : 'Enviar enlace mágico'}
      </button>
      <p className="text-xs text-kairikos-muted">
        Sólo los clientes con un chatbot Kairikos activo pueden acceder. Si no lo eres, te mostraremos una
        página informativa.
      </p>
    </form>
  );
}
