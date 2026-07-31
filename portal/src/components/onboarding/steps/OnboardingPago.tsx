'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useOnboarding } from '@/lib/onboarding/self-serve-context';

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

const PLAN_PRICES: Record<'starter' | 'pro' | 'premium', { cents: number; label: string }> = {
  starter: { cents: 9900, label: 'Starter' },
  pro: { cents: 24900, label: 'Pro' },
  premium: { cents: 49900, label: 'Premium' },
};

export function OnboardingPago() {
  const router = useRouter();
  const { state, startCheckout, abort, setStep, completeStep } = useOnboarding();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStep('pago');
    if (!state.email) router.replace('/onboarding/signup');
    else if (!state.productTier) router.replace('/onboarding/product');
    else if (!state.config.businessName) router.replace('/onboarding/config');
  }, [setStep, state.email, state.productTier, state.config.businessName, router]);

  const plan = state.productTier ? PLAN_PRICES[state.productTier] : null;

  async function handleCheckout() {
    if (!state.productTier || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const url = await startCheckout();
      completeStep('pago');
      if (url) {
        window.location.assign(url);
      } else {
        router.push('/onboarding/activado?mode=dev');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'checkout_failed');
      setSubmitting(false);
      void abort({ reason: 'checkout_error' });
    }
  }

  return (
    <div className="grid gap-5">
      <header className="space-y-1">
        <h2 id="wizard-heading-pago" className="text-xl font-semibold">
          Confirma y paga
        </h2>
        <p className="text-sm text-kairikos-muted">
          Te llevamos a Stripe para confirmar el pago. Volverás aquí cuando se active tu portal.
        </p>
      </header>

      <div className="rounded-2xl border border-kairikos-border bg-kairikos-surface2 p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-kairikos-muted">
          Resumen
        </h3>
        <dl className="mt-3 grid gap-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-kairikos-muted">Plan</dt>
            <dd className="font-semibold">{plan?.label ?? '—'}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-kairikos-muted">Negocio</dt>
            <dd>{state.config.businessName ?? '—'}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-kairikos-muted">Email</dt>
            <dd>{state.email ?? '—'}</dd>
          </div>
          <div className="flex items-center justify-between border-t border-kairikos-border pt-2">
            <dt className="font-semibold">Total mensual</dt>
            <dd className="text-lg font-bold">
              {plan ? formatPrice(plan.cents, 'EUR') : '—'}
            </dd>
          </div>
        </dl>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-kairikos-danger/40 bg-kairikos-danger/10 px-3 py-2 text-sm text-kairikos-danger"
        >
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => router.push('/onboarding/config')}
        >
          Atrás
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={handleCheckout}
          disabled={!plan || submitting}
          data-testid="pago-submit"
        >
          {submitting ? 'Conectando con Stripe…' : 'Pagar con Stripe'}
        </button>
      </div>
    </div>
  );
}
