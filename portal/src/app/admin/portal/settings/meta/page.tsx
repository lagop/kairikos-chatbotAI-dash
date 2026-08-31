import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { getMetaCredentialStatus } from '@/lib/meta-credentials';
import { MetaCredentialsPanel } from '@/components/portal/MetaCredentialsPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Meta · Admin',
  description: 'Credenciales de la app de Meta para los canales del chatbot y la Coexistence de recall.',
  alternates: { canonical: '/admin/portal/settings/meta' },
  robots: { index: false, follow: false },
};

export default async function AdminMetaSettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/meta');
  }

  const status = await getMetaCredentialStatus();

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Meta (WhatsApp/Messenger/Instagram)"
        description="Credenciales de la app de Meta que usan los canales del chatbot y la Coexistence de recall, sin tocar el .env del VPS."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      <MetaCredentialsPanel initialStatus={status} />
    </div>
  );
}
