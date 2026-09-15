import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { getOperatorAlertSettingsView } from '@/lib/operator-alert-settings';
import { OperatorAlertSettingsPanel } from '@/components/admin/OperatorAlertSettingsPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Alertas · Admin',
  description: 'A quién le llegan las alertas automáticas del portal.',
  alternates: { canonical: '/admin/portal/settings/alerts' },
  robots: { index: false, follow: false },
};

export default async function AdminAlertSettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/alerts');
  }

  const view = await getOperatorAlertSettingsView();

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Alertas"
        description="A quién le escribe el portal cuando algo necesita a una persona: un alta atascada, un WhatsApp caído, un token a punto de caducar."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      <OperatorAlertSettingsPanel
        initial={{
          operatorEmails: view.operatorEmails,
          operatorSource: view.operatorSource,
          ceoEmail: view.ceoEmail,
          ceoSource: view.ceoSource,
          updatedAt: view.updatedAt?.toISOString() ?? null,
          updatedBy: view.updatedBy,
        }}
      />
    </div>
  );
}
