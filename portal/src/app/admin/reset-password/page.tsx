import type { Metadata } from 'next';
import { Suspense } from 'react';
import AdminResetPasswordForm from './_client';

export const metadata: Metadata = {
  title: 'Nueva contraseña — Soporte',
  description: 'Establece una nueva contraseña para la vista de soporte de Kairikos.',
  alternates: { canonical: '/admin/reset-password' },
  robots: { index: false, follow: false },
};

export default function AdminResetPasswordPage() {
  return (
    <Suspense>
      <AdminResetPasswordForm />
    </Suspense>
  );
}
