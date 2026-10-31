import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { SiteContentEditor } from '@/components/portal/SiteContentEditor';
import { loadDraftEditor } from '@/lib/web-draft-editor';
import { DraftVersionsPanel } from '@/components/admin/DraftVersionsPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Editar borrador de web',
  robots: { index: false, follow: false },
};

// =============================================================================
// 30/10/2026 — /admin/portal/leads/[leadId]/borrador
//
// El operador ajusta el borrador de un prospecto antes de mandarle el enlace,
// con el mismo editor que la web de un cliente, en modo borrador
// (lib/web-draft-editor.ts explica qué cambia y por qué).
// =============================================================================

export default async function AdminDraftEditorPage(props: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await props.params;
  const session = await getSession();
  if (!session.isOperator) redirect(`/portal/login?next=/admin/portal/leads/${encodeURIComponent(leadId)}/borrador`);
  if (!isDatabaseConfigured) notFound();

  const loaded = await loadDraftEditor(prisma, leadId);
  if (!loaded.ok && loaded.reason === 'not_found') notFound();
  const verUrl = `/api/admin/portal/prospecting/web-draft/${leadId}`;

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title={loaded.ok ? `Borrador de ${loaded.negocio}` : 'Borrador de web'}
        description="El mismo editor que usa el cliente con su web, para ajustar el borrador antes de mandárselo."
        actions={
          // 31/10/2026 — a la lista de prospectos de su campaña. Antes iba a
          // /admin/portal/leads, que desde #368 ya no enseña prospectos sin
          // respuesta (LEADS_AWAITING_CLIENT_WHERE).
          <Link href={loaded.ok && loaded.clientId ? `/admin/portal/${loaded.clientId}?product=prospecting` : '/admin/portal/clients'} className="btn-ghost">
            Volver a prospectos
          </Link>
        }
      />
      {loaded.ok ? (
        <SiteContentEditor
          apiBase={`/api/admin/portal/prospecting/web-draft/${leadId}`}
          borrador={{ negocio: loaded.negocio, verUrl, subidas: true }}
          initialContent={loaded.data.content}
          phone={null}
          address={null}
          status="draft"
          lastPublishedAt={null}
          iconIds={loaded.data.iconIds}
          iconSymbols={loaded.data.iconSymbols}
          estilo={loaded.data.estilo}
          updatedAt={loaded.huella}
        />
      ) : (
        <p className="card text-sm text-kairikos-muted">
          {loaded.reason === 'old_design'
            ? 'Este borrador usa el diseño antiguo, sin plantilla, y no se puede editar aquí. Regéneralo desde la lista de prospectos para pasarlo a una plantilla aprobada de su sector.'
            : 'El contenido de este borrador no se puede leer. Regéneralo desde la lista de prospectos.'}
        </p>
      )}
      {/* 31/10/2026 — el historial que antes solo veía borrador-web.ts. */}
      <DraftVersionsPanel apiBase={verUrl} />
    </div>
  );
}
