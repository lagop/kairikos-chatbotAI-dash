import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Seguridad · Admin',
  description: 'Verificación en dos pasos del operador.',
  alternates: { canonical: '/admin/portal/settings/security' },
  robots: { index: false, follow: false },
};

// Desde el 22/09/2026 la verificación en dos pasos se da de alta en la propia
// entrada (con un código enviado al email, ver src/lib/operator-login.ts), y
// nadie llega aquí sin haberla pasado. Esta página ya no la activa: enseña
// su estado y cuántos códigos de recuperación quedan.
export default async function AdminSecuritySettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/admin/login');
  }

  const operator =
    isDatabaseConfigured && session.email
      ? await prisma.operator.findUnique({
          where: { email: session.email },
          select: {
            totpEnrolledAt: true,
            _count: { select: { recoveryCodes: { where: { consumedAt: null } } } },
          },
        })
      : null;
  const remaining = operator?._count.recoveryCodes ?? 0;
  const dateFormat = new Intl.DateTimeFormat('es-ES', { dateStyle: 'long' });

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Seguridad"
        description="La verificación en dos pasos se pide al entrar y otra vez antes de las acciones sensibles."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      <div className="card space-y-3" data-testid="totp-status-panel">
        <h2 className="text-lg font-semibold">Verificación en dos pasos</h2>
        <p
          className="inline-flex items-center gap-2 rounded-full border border-kairikos-success/40 bg-kairikos-success/10 px-3 py-1 text-sm text-kairikos-success"
          data-testid="totp-enrolled-badge"
        >
          Activada
          {operator?.totpEnrolledAt ? ` desde el ${dateFormat.format(operator.totpEnrolledAt)}` : ''}
        </p>
        <p className="text-sm text-kairikos-muted" data-testid="totp-recovery-remaining">
          Te quedan {remaining} de 8 códigos de recuperación. Cada uno sirve una vez si pierdes el móvil.
          {remaining <= 2 ? ' Quedan pocos: cuando se acaben, solo la app del móvil te dejará entrar.' : ''}
        </p>
      </div>
    </div>
  );
}
