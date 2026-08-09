import type { Metadata } from 'next';
import { Suspense } from 'react';
import AdminSetupPasswordForm from './_client';

export const metadata: Metadata = {
  title: 'Crear contraseña — Soporte',
  description: 'Configura tu contraseña para acceder a la vista de soporte de Kairikos.',
  alternates: { canonical: '/admin/setup-password' },
  robots: { index: false, follow: false },
};

export default function AdminSetupPasswordPage() {
  return (
    <Suspense>
      <AdminSetupPasswordForm />
    </Suspense>
  );
}
