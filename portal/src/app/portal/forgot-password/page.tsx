import type { Metadata } from 'next';
import { Suspense } from 'react';
import ForgotPasswordForm from './_client';

export const metadata: Metadata = {
  title: 'Restablecer contraseña',
  description: 'Recibe un enlace para restablecer la contraseña de tu portal Kairikos.',
  alternates: { canonical: '/portal/forgot-password' },
  robots: { index: false, follow: false },
};

export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <ForgotPasswordForm />
    </Suspense>
  );
}
