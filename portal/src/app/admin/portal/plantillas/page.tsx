import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { PageHeading } from '@/components/portal/PageHeading';
import { SiteTemplateLab, type SiteTemplateRow } from '@/components/admin/SiteTemplateLab';
import { recoverStaleJobs } from '@/lib/site-template-jobs';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Plantillas web · Admin',
  description: 'La biblioteca de plantillas de diseño que hace la IA para las webs de los clientes.',
  alternates: { canonical: '/admin/portal/plantillas' },
  robots: { index: false, follow: false },
};

// Webs con IA, entrega 2 (27/10/2026) — la biblioteca de plantillas por sector.
export default async function AdminSiteTemplatesPage() {
  const session = await getSession();
  if (!session.isOperator) redirect('/portal/login?next=/admin/portal/plantillas');

  let templates: SiteTemplateRow[] = [];
  if (isDatabaseConfigured) {
    await recoverStaleJobs(prisma);
    const rows = await prisma.siteTemplate.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        nombre: true,
        sector: true,
        variante: true,
        origen: true,
        modelo: true,
        estado: true,
        validacion: true,
        createdAt: true,
        _count: { select: { websites: true } },
      },
    });
    templates = rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), validacion: r.validacion as SiteTemplateRow['validacion'] }));
  }

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Plantillas web"
        description="La IA diseña plantillas por sector; el contenido de cada negocio va aparte. Una plantilla aprobada sirve a todas las webs de su sector."
      />
      <SiteTemplateLab initial={templates} />
    </div>
  );
}
