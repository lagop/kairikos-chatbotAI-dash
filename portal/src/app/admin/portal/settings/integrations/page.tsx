import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { getIntegrationCredentialStatus } from '@/lib/integration-credentials';
import { IntegrationCredentialsPanel } from '@/components/portal/IntegrationCredentialsPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Integraciones · Admin',
  description: 'Claves de API de terceros usadas por el portal, fuera del ámbito de Stripe/facturación.',
  alternates: { canonical: '/admin/portal/settings/integrations' },
  robots: { index: false, follow: false },
};

export default async function AdminIntegrationsSettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/integrations');
  }

  const googlePlaces = await getIntegrationCredentialStatus('google_places');

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Integraciones"
        description="Claves de API de terceros que el portal usa por su cuenta — no relacionadas con Stripe ni la facturación de clientes."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      <IntegrationCredentialsPanel initialGooglePlaces={googlePlaces} />
    </div>
  );
}
