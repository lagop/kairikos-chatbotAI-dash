import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { OnboardingProvider } from '@/lib/onboarding/self-serve-context';

export const metadata: Metadata = {
  title: 'Activar Kairikos — Wizard de alta',
  description:
    'Wizard self-serve para activar tu portal Kairikos: registro, producto, configuración, pago y activación en menos de 5 minutos.',
  robots: {
    index: false,
    follow: false,
  },
};

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-kairikos-bg text-kairikos-text">
      <OnboardingProvider>
        <div className="mx-auto flex max-w-page flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10">
          <header className="flex items-center justify-between">
            <Link
              href="/empezar"
              className="flex items-center gap-2 text-sm font-semibold tracking-tight"
              aria-label="Volver a Empezar"
            >
              <span
                aria-hidden
                className="grid h-8 w-8 place-items-center rounded-lg bg-kairikos-accent text-sm font-bold"
              >
                K
              </span>
              Kairikos · Activación
            </Link>
            <Link
              href="/portal/login"
              className="text-sm text-kairikos-muted hover:text-kairikos-text"
            >
              Ya tengo cuenta
            </Link>
          </header>
          <main className="grid gap-6" data-testid="onboarding-shell">
            {children}
          </main>
          <footer className="border-t border-kairikos-border pt-4 text-xs text-kairikos-muted">
            <p>
              ¿Problemas durante el alta? Escríbenos a{' '}
              <a
                href="mailto:soporte@kairikos.com"
                className="underline-offset-2 hover:underline"
              >
                soporte@kairikos.com
              </a>
              .
            </p>
          </footer>
        </div>
      </OnboardingProvider>
    </div>
  );
}
