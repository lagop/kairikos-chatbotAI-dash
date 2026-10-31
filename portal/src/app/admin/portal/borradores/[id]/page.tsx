import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { SiteContentEditor } from '@/components/portal/SiteContentEditor';
import { loadPublicDraftEditor } from '@/lib/public-draft-editor';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Editar borrador pedido',
  robots: { index: false, follow: false },
};

// =============================================================================
// 30/10/2026 — /admin/portal/borradores/[id]
//
// El operador retoca el borrador que pidió un negocio en kairikos.com antes de
// que se le envíe (lib/public-draft-delivery.ts), con el editor de webs en
// modo borrador, igual que el de un prospecto (/admin/portal/leads/[id]/borrador).
// =============================================================================

export default async function AdminPublicDraftEditorPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = await getSession();
  if (!session.isOperator) redirect(`/portal/login?next=/admin/portal/borradores/${encodeURIComponent(id)}`);
  if (!isDatabaseConfigured) notFound();

  const loaded = await loadPublicDraftEditor(prisma, id);
  if (!loaded.ok && loaded.reason === 'not_found') notFound();
  const sent = (await prisma.publicDraftRequest.findUnique({ where: { id }, select: { sentAt: true } }))?.sentAt ?? null;
  const apiBase = `/api/admin/portal/borradores/${id}`;

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title={loaded.ok ? `Borrador de ${loaded.negocio}` : 'Borrador pedido'}
        description="Lo pidió en kairikos.com. Retócalo antes de que se le envíe; «Enviar ahora» está en la lista de borradores."
        actions={
          <Link href="/admin/portal/borradores" className="btn-ghost">
            Volver a borradores
          </Link>
        }
      />
      {loaded.ok ? (
        <SiteContentEditor
          apiBase={apiBase}
          borrador={{
            negocio: loaded.negocio,
            verUrl: `${apiBase}/ver`,
            aviso: sent
              ? 'Ya se le envió: lo que guardes lo verá en su enlace la próxima vez que lo abra. Aquí no hay historial; «Deshacer» sí funciona mientras no cierres la página.'
              : 'Todavía no se le ha enviado: lo que guardes es lo que recibirá. Aquí no hay historial; «Deshacer» sí funciona mientras no cierres la página.',
            guardado: sent ? 'Guardado. Su enlace ya enseña el borrador así.' : 'Guardado. Es lo que recibirá cuando se envíe.',
            // 31/10/2026 — con sus fotos (PublicDraftImage, lib/web-draft-images.ts).
            subidas: true,
          }}
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
            ? 'Este borrador usa el diseño antiguo, sin plantilla, y no se puede editar aquí.'
            : 'El contenido de este borrador no se puede leer.'}
        </p>
      )}
    </div>
  );
}
