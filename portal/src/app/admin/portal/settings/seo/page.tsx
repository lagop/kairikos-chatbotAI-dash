import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { getContentGenerationMinIntervalDays } from '@/lib/seo-settings';
import { SeoSettingsPanel } from '@/components/portal/SeoSettingsPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'SEO con IA · Admin',
  description: 'Configuración operativa del producto SEO con IA — cadencia de generación de contenido.',
  alternates: { canonical: '/admin/portal/settings/seo' },
  robots: { index: false, follow: false },
};

export default async function AdminSeoSettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/seo');
  }

  const contentGenerationMinIntervalDays = await getContentGenerationMinIntervalDays();

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="SEO con IA"
        description="Configuración operativa del producto, no relacionada con Stripe ni con las credenciales de un cliente concreto."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      <SeoSettingsPanel initialMinIntervalDays={contentGenerationMinIntervalDays} />
    </div>
  );
}
