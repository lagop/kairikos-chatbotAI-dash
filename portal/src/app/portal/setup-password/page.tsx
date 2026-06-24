import type { Metadata } from 'next';
import { Suspense } from 'react';
import SetupPasswordForm from './_client';

export const metadata: Metadata = {
  title: 'Crear contraseña',
  description: 'Configura tu contraseña para acceder al portal Kairikos.',
  alternates: { canonical: '/portal/setup-password' },
  robots: { index: false, follow: false },
};

export default function SetupPasswordPage() {
  return (
    <Suspense>
      <SetupPasswordForm />
    </Suspense>
  );
}
