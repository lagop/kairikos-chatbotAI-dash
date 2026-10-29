import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { PageHeading } from '@/components/portal/PageHeading';
import { SiteTemplateLab, type SiteTemplateRow } from '@/components/admin/SiteTemplateLab';
import { listSiteTemplates } from '@/lib/site-template-library';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Plantillas web · Admin',
  description: 'La biblioteca de plantillas de diseño que hace la IA para las webs de los clientes.',
  alternates: { canonical: '/admin/portal/plantillas' },
  robots: { index: false, follow: false },
};

// Webs con IA, entrega 2 (27/10/2026) — la biblioteca de plantillas por sector.
export default async function AdminSiteTemplatesPage(props: { searchParams: Promise<{ nombre?: string; encargo?: string; sector?: string }> }) {
  const searchParams = await props.searchParams;
  const session = await getSession();
  if (!session.isOperator) redirect('/portal/login?next=/admin/portal/plantillas');

  let templates: SiteTemplateRow[] = [];
  if (isDatabaseConfigured) {
    templates = await listSiteTemplates(prisma);
  }

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Plantillas web"
        description="La IA diseña plantillas por sector; el contenido de cada negocio va aparte. Una plantilla aprobada sirve a todas las webs de su sector."
      />
      {/* Desde la ficha de un cliente: «Encargar una a medida» llega con su encargo. */}
      <SiteTemplateLab
        initial={templates}
        initialForm={{ nombre: searchParams.nombre?.slice(0, 80), encargo: searchParams.encargo?.slice(0, 1500), sector: searchParams.sector?.slice(0, 40) }}
      />
    </div>
  );
}
