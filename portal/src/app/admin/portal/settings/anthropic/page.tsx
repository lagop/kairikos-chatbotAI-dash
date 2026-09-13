import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { getAnthropicCredentialStatus } from '@/lib/anthropic-credentials';
import { AnthropicCredentialsPanel } from '@/components/portal/AnthropicCredentialsPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'IA (Anthropic) · Admin',
  description: 'Credencial de Anthropic que alimenta el chatbot y el resto de funciones de IA del portal.',
  alternates: { canonical: '/admin/portal/settings/anthropic' },
  robots: { index: false, follow: false },
};

export default async function AdminAnthropicSettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/anthropic');
  }

  const status = await getAnthropicCredentialStatus();

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="IA (Anthropic)"
        description="Guarda la clave de Anthropic que alimenta el chatbot, Captación con IA, las respuestas de reseñas, los resúmenes de conversación y el contenido SEO — sin tocar el .env del VPS."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      <AnthropicCredentialsPanel initialStatus={status} />
    </div>
  );
}
