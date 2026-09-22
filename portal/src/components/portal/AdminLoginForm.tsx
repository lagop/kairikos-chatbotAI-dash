'use client';

import { useSearchParams } from 'next/navigation';
import { useId, useState } from 'react';

// Entrada del operador en varios pasos (22/09/2026): contraseña, y después
// SIEMPRE un segundo factor. La sesión solo existe cuando el segundo paso
// sale bien — ver src/lib/operator-login.ts. Ya no pasa por NextAuth.

type Step = 'password' | 'totp' | 'email_code' | 'enroll' | 'recovery_codes';

const ERROR_TEXT: Record<string, string> = {
  invalid_credentials: 'Email o contraseña incorrectos.',
  invalid_code: 'Código incorrecto o ya usado. Espera al siguiente y vuelve a probar.',
  too_many_requests: 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
  too_many_attempts: 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
  challenge_expired: 'Han pasado más de 10 minutos. Vuelve a escribir tu contraseña.',
  email_unavailable: 'No se pudo enviar el código a tu email. Escríbenos a hola@kairikos.com.',
  not_configured: 'Error de configuración del servidor. Avisa al equipo de soporte.',
  service_unavailable: 'El servicio no está disponible ahora mismo. Vuelve a probar en un momento.',
};

function errorText(code: string | null | undefined): string {
  return (code && ERROR_TEXT[code]) || 'No se pudo iniciar sesión. Vuelve a probar.';
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

export function AdminLoginForm() {
  const params = useSearchParams();
  const isMustReset = params.get('reason') === 'must_reset' || params.get('error') === 'must_reset';
  const id = useId();

  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(isMustReset ? 'Primero debes crear tu contraseña.' : null);

  function restart(message: string) {
    setStep('password');
    setChallenge(null);
    setCode('');
    setSecret(null);
    setError(message);
  }

  async function submitPassword() {
    if (!email.includes('@')) return setError('Introduce un email válido.');
    if (!password) return setError('Introduce tu contraseña.');
    const { ok, data } = await postJson('/api/operator/login', { email, password });
    if (!ok) return setError(errorText(data.error as string));
    setPassword('');
    setChallenge(data.challenge as string);
    setStep(data.step === 'email_code' ? 'email_code' : 'totp');
  }

  async function submitEmailCode() {
    const { ok, data } = await postJson('/api/operator/login/email-code', { challenge, code });
    if (!ok) {
      if (data.error === 'challenge_expired') return restart(errorText('challenge_expired'));
      return setError(errorText(data.error as string));
    }
    setChallenge(data.challenge as string);
    setSecret(data.secret as string);
    setCode('');
    setStep('enroll');
  }

  async function submitTotp() {
    const { ok, data } = await postJson('/api/operator/login/totp', { challenge, code });
    if (!ok) {
      if (data.error === 'challenge_expired') return restart(errorText('challenge_expired'));
      return setError(errorText(data.error as string));
    }
    if (Array.isArray(data.recoveryCodes)) {
      setRecoveryCodes(data.recoveryCodes as string[]);
      setStep('recovery_codes');
      return;
    }
    window.location.href = '/admin/portal/clients';
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (step === 'password') await submitPassword();
      else if (step === 'email_code') await submitEmailCode();
      else if (step === 'totp' || step === 'enroll') await submitTotp();
    } catch {
      setError('No se pudo conectar. Vuelve a probar.');
    } finally {
      setSubmitting(false);
    }
  }

  if (step === 'recovery_codes') {
    return (
      <div className="space-y-4" data-testid="login-recovery-codes">
        <p className="text-sm font-semibold text-kairikos-success">Verificación en dos pasos activada.</p>
        <p className="text-sm text-kairikos-muted">
          Guarda estos códigos de recuperación en un lugar seguro. Cada uno te deja entrar una vez si pierdes el
          móvil, y no se vuelven a mostrar.
        </p>
        <ul className="grid grid-cols-2 gap-2 rounded-lg border border-kairikos-border bg-kairikos-surface2 p-3 font-mono text-sm">
          {recoveryCodes.map((rc) => (
            <li key={rc}>{rc}</li>
          ))}
        </ul>
        <button
          type="button"
          className="btn-primary w-full"
          onClick={() => {
            window.location.href = '/admin/portal/clients';
          }}
        >
          Ya los he guardado
        </button>
      </div>
    );
  }

  const codeLabel =
    step === 'email_code'
      ? 'Código que te hemos enviado por email'
      : step === 'enroll'
        ? 'Código de 6 dígitos de tu app'
        : 'Código de tu app de autenticación';

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {step === 'password' ? (
        <>
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
              data-testid="password-input"
            />
          </div>
        </>
      ) : (
        <>
          {step === 'email_code' ? (
            <p className="text-sm text-kairikos-muted">
              Tu cuenta aún no tiene verificación en dos pasos. Para activarla, te hemos enviado un código a{' '}
              <strong>{email}</strong>. Caduca en 10 minutos.
            </p>
          ) : null}
          {step === 'enroll' ? (
            <div className="space-y-2">
              <p className="text-sm text-kairikos-muted">
                Añade esta clave en tu app de autenticación (Google Authenticator, 1Password…) y escribe el código
                que genere.
              </p>
              <p
                className="select-all break-all rounded-lg border border-kairikos-border bg-kairikos-surface2 px-3 py-2 font-mono text-sm"
                data-testid="totp-secret"
              >
                {secret}
              </p>
            </div>
          ) : null}
          {step === 'totp' ? (
            <p className="text-sm text-kairikos-muted">
              Escribe el código de 6 dígitos de tu app. Si has perdido el móvil, sirve uno de tus códigos de
              recuperación.
            </p>
          ) : null}
          <div>
            <label htmlFor={`${id}-code`} className="label">
              {codeLabel}
            </label>
            <input
              id={`${id}-code`}
              name="code"
              type="text"
              required
              autoFocus
              autoComplete="one-time-code"
              inputMode={step === 'totp' ? 'text' : 'numeric'}
              maxLength={step === 'totp' ? 16 : 6}
              value={code}
              onChange={(e) => setCode(e.target.value.trim())}
              className="input font-mono tracking-widest"
              data-testid="code-input"
            />
          </div>
        </>
      )}
      {error ? (
        <p role="alert" data-testid="signin-error" className="text-sm text-kairikos-danger">
          {error}
        </p>
      ) : null}
      <button type="submit" data-testid="login-submit" className="btn-primary w-full" disabled={submitting}>
        {submitting ? 'Comprobando…' : step === 'password' ? 'Continuar' : 'Entrar'}
      </button>
      {step !== 'password' ? (
        <button type="button" className="btn-ghost w-full text-sm" onClick={() => restart('')}>
          Volver a empezar
        </button>
      ) : null}
      <div className="flex flex-col gap-1 text-center">
        {isMustReset ? (
          <p className="text-xs text-kairikos-muted">
            <a className="underline" href="/admin/setup-password">
              Configura tu contraseña
            </a>
          </p>
        ) : (
          <p className="text-xs text-kairikos-muted">
            ¿Olvidaste tu contraseña?{' '}
            <a className="underline" href="/admin/forgot-password">
              Restablécela aquí
            </a>
          </p>
        )}
        <p className="text-xs text-kairikos-muted">
          ¿Problemas para acceder? Escríbenos a{' '}
          <a className="underline" href="mailto:hola@kairikos.com">
            hola@kairikos.com
          </a>
          .
        </p>
      </div>
    </form>
  );
}
