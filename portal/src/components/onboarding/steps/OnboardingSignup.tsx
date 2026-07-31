'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useOnboarding } from '@/lib/onboarding/self-serve-context';

export function OnboardingSignup() {
  const router = useRouter();
  const { state, signup, setStep, completeStep } = useOnboarding();
  const [email, setEmail] = useState(state.email ?? '');
  const [accept, setAccept] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStep('signup');
  }, [setStep]);

  const isValid = /.+@.+\..+/.test(email) && accept;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!isValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await signup({ email });
      completeStep('signup');
      router.push('/onboarding/product');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'signup_failed');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-5" noValidate>
      <header className="space-y-1">
        <h2 id="wizard-heading-signup" className="text-xl font-semibold">
          Empecemos por tu email
        </h2>
        <p className="text-sm text-kairikos-muted">
          Te enviaremos un enlace mágico para acceder a tu portal cuando esté activo.
        </p>
      </header>

      <label className="grid gap-1">
        <span className="label">Email de trabajo</span>
        <input
          data-testid="signup-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input"
          placeholder="tu@negocio.es"
        />
      </label>

      <label className="flex items-start gap-2 text-sm text-kairikos-muted">
        <input
          data-testid="signup-accept"
          type="checkbox"
          checked={accept}
          onChange={(e) => setAccept(e.target.checked)}
          className="mt-1 h-4 w-4 rounded border-kairikos-border bg-kairikos-surface2"
        />
        <span>
          Acepto los términos del servicio y la política de privacidad de Kairikos.
        </span>
      </label>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-kairikos-danger/40 bg-kairikos-danger/10 px-3 py-2 text-sm text-kairikos-danger"
        >
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-kairikos-muted">Sin tarjetas. Sin compromiso.</p>
        <button
          type="submit"
          className="btn-primary"
          disabled={!isValid || submitting}
          data-testid="signup-submit"
        >
          {submitting ? 'Creando cuenta…' : 'Continuar'}
        </button>
      </div>
    </form>
  );
}
