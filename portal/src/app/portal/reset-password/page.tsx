import type { Metadata } from 'next';
import { Suspense } from 'react';
import ResetPasswordForm from './_client';

export const metadata: Metadata = {
  title: 'Nueva contraseña',
  description: 'Establece una nueva contraseña para tu portal Kairikos.',
  alternates: { canonical: '/portal/reset-password' },
  robots: { index: false, follow: false },
};

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
