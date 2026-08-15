import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { TotpEnrollmentPanel } from '@/components/portal/TotpEnrollmentPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Seguridad · Admin',
  description: 'Verificación en dos pasos para acciones sensibles del operador.',
  alternates: { canonical: '/admin/portal/settings/security' },
  robots: { index: false, follow: false },
};

export default async function AdminSecuritySettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/security');
  }

  const operator =
    isDatabaseConfigured && session.email
      ? await prisma.operator.findUnique({
          where: { email: session.email },
          select: { totpEnrolledAt: true },
        })
      : null;

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Seguridad"
        description="Configura la verificación en dos pasos que se exige antes de guardar credenciales de Stripe o cambiar precios del catálogo."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      <TotpEnrollmentPanel initiallyEnrolled={Boolean(operator?.totpEnrolledAt)} />
    </div>
  );
}
