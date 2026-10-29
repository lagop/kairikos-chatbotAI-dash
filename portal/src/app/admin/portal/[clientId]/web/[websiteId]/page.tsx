import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { SiteContentEditor } from '@/components/portal/SiteContentEditor';
import { loadSiteEditorData } from '@/lib/site-editor-data';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Editar web del cliente',
  robots: { index: false, follow: false },
};

// =============================================================================
// 28/10/2026 — /admin/portal/[clientId]/web/[websiteId]
//
// El operador edita la web de un cliente con el MISMO editor que el cliente
// (SiteContentEditor): textos, secciones, bloques, blog, color y letra, logo
// y fotos. Para cuando el cliente manda sus fotos por WhatsApp o pide un
// cambio por teléfono. Guarda y publica por las rutas de operador
// (/api/admin/portal/websites/[id]/…), que comparten la lógica con las del
// cliente y firman la auditoría con el operador.
//
// La plantilla y el paso al editor nuevo siguen en la ficha del cliente
// (ClientWebsitePanel): son estructura, no contenido.
// =============================================================================

export default async function AdminWebsiteEditorPage(props: { params: Promise<{ clientId: string; websiteId: string }> }) {
  const params = await props.params;
  const session = await getSession();
  if (!session.isOperator) {
    redirect(`/portal/login?next=/admin/portal/${encodeURIComponent(params.clientId)}/web/${encodeURIComponent(params.websiteId)}`);
  }
  if (!isDatabaseConfigured) notFound();

  // El sitio tiene que ser de ESE cliente: la URL lleva los dos ids.
  const site = await prisma.clientWebsite.findFirst({ where: { id: params.websiteId, clientId: params.clientId } });
  if (!site) notFound();
  const data = await loadSiteEditorData(prisma, site);

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title={`Web de ${site.businessName}`}
        description="El mismo editor que usa el cliente en su portal."
        actions={
          <Link href={`/admin/portal/${encodeURIComponent(params.clientId)}`} className="btn-ghost">
            Volver a la ficha
          </Link>
        }
      />
      {data ? (
        <SiteContentEditor
          apiBase={`/api/admin/portal/websites/${site.id}`}
          operador={{ clienteNombre: site.businessName }}
          initialContent={data.content}
          phone={site.phone}
          address={site.address}
          status={site.status}
          lastPublishedAt={site.lastPublishedAt?.toISOString() ?? null}
          iconIds={data.iconIds}
          iconSymbols={data.iconSymbols}
          estilo={data.estilo}
          updatedAt={site.updatedAt.toISOString()}
        />
      ) : (
        <p className="card text-sm text-kairikos-muted">
          Esta web todavía usa el editor de antes. Pásala al editor nuevo desde la ficha del cliente («Diseño de la web») para editarla aquí.
        </p>
      )}
    </div>
  );
}
