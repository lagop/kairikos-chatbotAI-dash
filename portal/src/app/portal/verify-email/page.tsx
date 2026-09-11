import type { Metadata } from 'next';
import { Suspense } from 'react';
import VerifyEmailForm from './_client';

export const metadata: Metadata = {
  title: 'Confirma tu email',
  description: 'Confirma tu correo para tu cuenta del portal Kairikos.',
  alternates: { canonical: '/portal/verify-email' },
  robots: { index: false, follow: false },
};

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailForm />
    </Suspense>
  );
}
