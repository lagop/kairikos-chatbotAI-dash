'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useOnboarding } from '@/lib/onboarding/self-serve-context';

interface ProductCard {
  id: string;
  tier: 'starter' | 'pro' | 'premium';
  name: string;
  tagline: string;
  priceCents: number;
  currency: string;
  features: readonly string[];
}

const CATALOG: readonly ProductCard[] = [
  {
    id: 'starter-onboarding',
    tier: 'starter',
    name: 'Starter',
    tagline: 'Para empezar en unas horas.',
    priceCents: 9900,
    currency: 'EUR',
    features: [
      'Chatbot IA en tu web',
      '5 páginas web',
      'SEO básico',
      'Soporte por email',
    ],
  },
  {
    id: 'pro-onboarding',
    tier: 'pro',
    name: 'Pro',
    tagline: 'El siguiente nivel para crecer.',
    priceCents: 24900,
    currency: 'EUR',
    features: [
      'Todo lo de Starter',
      'Hasta 15 páginas',
      'SEO avanzado y blog',
      'Producto de Reseñas',
    ],
  },
  {
    id: 'premium-onboarding',
    tier: 'premium',
    name: 'Premium',
    tagline: 'Hecho a medida con prioridad.',
    priceCents: 49900,
    currency: 'EUR',
    features: [
      'Todo lo de Pro',
      'Integraciones a medida',
      'Soporte prioritario',
      'E-commerce opcional',
    ],
  },
] as const;

function formatPrice(cents: number, currency: string): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function OnboardingProduct() {
  const router = useRouter();
  const { state, selectProduct, setStep, completeStep } = useOnboarding();

  useEffect(() => {
    setStep('product');
    if (!state.email) router.replace('/onboarding/signup');
  }, [setStep, state.email, router]);

  function handleSelect(product: ProductCard) {
    void selectProduct({ productId: product.id, productTier: product.tier }).then(() => {
      completeStep('product');
      router.push('/onboarding/config');
    });
  }

  return (
    <div className="grid gap-5">
      <header className="space-y-1">
        <h2 id="wizard-heading-product" className="text-xl font-semibold">
          Elige tu plan
        </h2>
        <p className="text-sm text-kairikos-muted">
          Puedes cambiar de plan en cualquier momento. Sin permanencia.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        {CATALOG.map((product) => {
          const selected = state.productTier === product.tier;
          return (
            <button
              key={product.id}
              type="button"
              data-testid={`product-card-${product.tier}`}
              data-selected={selected ? 'true' : 'false'}
              onClick={() => handleSelect(product)}
              className={`flex h-full flex-col items-start gap-3 rounded-2xl border p-4 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-kairikos-accent ${
                selected
                  ? 'border-kairikos-accent bg-kairikos-surface2 ring-2 ring-kairikos-accent/40'
                  : 'border-kairikos-border bg-kairikos-surface hover:border-kairikos-accent/50'
              }`}
            >
              <div className="flex w-full items-center justify-between">
                <span className="text-sm font-semibold uppercase tracking-wide text-kairikos-muted">
                  {product.tier}
                </span>
                {selected ? (
                  <span className="pill-success" aria-label="Plan seleccionado">
                    Seleccionado
                  </span>
                ) : null}
              </div>
              <h3 className="text-lg font-semibold">{product.name}</h3>
              <p className="text-sm text-kairikos-muted">{product.tagline}</p>
              <p className="text-2xl font-bold">
                {formatPrice(product.priceCents, product.currency)}
                <span className="ml-1 text-sm font-normal text-kairikos-muted">
                  /mes
                </span>
              </p>
              <ul className="space-y-1 text-sm text-kairikos-muted">
                {product.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span aria-hidden className="mt-1 h-1.5 w-1.5 rounded-full bg-kairikos-accent2" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>
    </div>
  );
}
