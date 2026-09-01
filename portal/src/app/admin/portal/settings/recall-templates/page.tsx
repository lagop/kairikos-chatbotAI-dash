import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { RecallTemplatesPanel, type RecallTemplateStatus } from '@/components/portal/RecallTemplatesPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Plantillas de WhatsApp · Admin',
  description: 'Texto de las 7 plantillas de WhatsApp que recall envía a la WABA de cada cliente nuevo.',
  alternates: { canonical: '/admin/portal/settings/recall-templates' },
  robots: { index: false, follow: false },
};

export default async function AdminRecallTemplatesSettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/recall-templates');
  }

  const templates: RecallTemplateStatus[] = isDatabaseConfigured
    ? (await prisma.recallTemplateDefinition.findMany({ orderBy: { sortOrder: 'asc' } })).map((row) => ({
        name: row.name,
        languageCode: row.languageCode,
        category: row.category,
        bodyText: row.bodyText,
        bodyExamples: row.bodyExamples,
        updatedAt: row.updatedAt.toISOString(),
        updatedByEmail: row.updatedByEmail,
      }))
    : [];

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Plantillas de WhatsApp (recall)"
        description="Las 7 plantillas que se envían automáticamente a la WABA de cada cliente nuevo al conectar Coexistence."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      {templates.length === 0 ? (
        <EmptyState title="Modo de demostración" description="Esta vista necesita una base de datos configurada." />
      ) : (
        <RecallTemplatesPanel initialTemplates={templates} />
      )}
    </div>
  );
}
