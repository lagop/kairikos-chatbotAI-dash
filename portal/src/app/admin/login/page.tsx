import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AdminLoginForm } from '@/components/portal/AdminLoginForm';

export const metadata: Metadata = {
  title: 'Iniciar sesión — Soporte',
  description: 'Inicia sesión en la vista de soporte de Kairikos con tu email y contraseña.',
  alternates: { canonical: '/admin/login' },
  robots: { index: false, follow: false },
};

export default function AdminLoginPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10 sm:px-6">
      <div className="card">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">
            Soporte Kairikos
          </p>
          <h1
            className="mt-1 text-2xl font-semibold tracking-tight"
            data-testid="login-title"
          >
            Iniciar sesión
          </h1>
          <p className="mt-2 text-sm text-kairikos-muted">
            Introduce tu email y contraseña de operador para acceder a la vista de soporte.
          </p>
        </header>
        <Suspense>
          <AdminLoginForm />
        </Suspense>
      </div>
      <p className="mt-6 text-center text-xs text-kairikos-muted">
        ¿Necesitas acceso de soporte? Escríbenos a{' '}
        <a className="underline" href="mailto:hola@kairikos.com">
          hola@kairikos.com
        </a>
        .
      </p>
    </div>
  );
}
