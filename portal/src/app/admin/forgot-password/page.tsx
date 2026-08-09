import type { Metadata } from 'next';
import { Suspense } from 'react';
import AdminForgotPasswordForm from './_client';

export const metadata: Metadata = {
  title: 'Restablecer contraseña — Soporte',
  description: 'Recibe un enlace para restablecer la contraseña de la vista de soporte Kairikos.',
  alternates: { canonical: '/admin/forgot-password' },
  robots: { index: false, follow: false },
};

export default function AdminForgotPasswordPage() {
  return (
    <Suspense>
      <AdminForgotPasswordForm />
    </Suspense>
  );
}
