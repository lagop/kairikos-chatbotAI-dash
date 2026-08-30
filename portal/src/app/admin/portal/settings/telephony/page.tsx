import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { getTwilioCredentialStatus } from '@/lib/twilio-credentials';
import { TwilioCredentialsPanel } from '@/components/portal/TwilioCredentialsPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Telefonía · Admin',
  description: 'Credenciales de Twilio para el pool de números virtuales de recall.',
  alternates: { canonical: '/admin/portal/settings/telephony' },
  robots: { index: false, follow: false },
};

export default async function AdminTelephonySettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/telephony');
  }

  const status = await getTwilioCredentialStatus();

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Telefonía"
        description="Guarda las credenciales de Twilio que usa el pool de números virtuales de recall, sin tocar el .env del VPS."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      <TwilioCredentialsPanel initialStatus={status} />
    </div>
  );
}
