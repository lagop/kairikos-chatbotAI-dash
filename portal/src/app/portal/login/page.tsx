import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from '@/components/portal/LoginForm';

export const metadata: Metadata = {
  title: 'Iniciar sesión',
  description: 'Inicia sesión en el portal de cliente Kairikos con un enlace mágico a tu email.',
  alternates: { canonical: '/portal/login' },
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10 sm:px-6">
      <div className="card">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">
            Portal Kairikos
          </p>
          <h1
            className="mt-1 text-2xl font-semibold tracking-tight"
            data-testid="login-title"
          >
            Iniciar sesión
          </h1>
          <p className="mt-2 text-sm text-kairikos-muted">
            Te enviaremos un enlace de acceso a tu email. No necesitas recordar contraseña.
          </p>
        </header>
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
      <p className="mt-6 text-center text-xs text-kairikos-muted">
        ¿No tienes acceso? Escríbenos a{' '}
        <a className="underline" href="mailto:hola@kairikos.com">
          hola@kairikos.com
        </a>
        .
      </p>
    </div>
  );
}
