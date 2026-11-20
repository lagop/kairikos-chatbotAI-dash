import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { PageHeading } from '@/components/portal/PageHeading';
import { CarteraHomeEditor } from '@/components/portal/CarteraHomeEditor';
import { findSiteForOwner } from '@/lib/cartera/site';
import { loadHomeForPanel, siteAgents } from '@/lib/cartera/homes';
import { HOME_STATUSES, STATUS_LABELS } from '@/lib/cartera/home-rules';
import { isUuid } from '@/lib/cartera/portal-auth';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Ficha de la casa',
  robots: { index: false, follow: false },
};

// =============================================================================
// Cartera — la ficha de una casa (/portal/cartera/<id>). Solo casas del sitio
// de ESTE cliente: un id ajeno da 404. En la gracia de una baja se ve en solo
// lectura (las rutas de escritura responden 403 'read_only').
// =============================================================================

export default async function CarteraHomePage(props: { params: Promise<{ id: string }> }) {
  await requirePortalSession();
  const { id } = await props.params;
  const resolved = isDatabaseConfigured ? await resolveClientFromSession() : null;
  const owner = resolved?.source === 'database' ? await findSiteForOwner(prisma, resolved.clientId) : null;
  if (!owner) redirect('/portal/cartera');
  if (!isUuid(id)) notFound();
  const home = await loadHomeForPanel(prisma, owner.site.id, id.toLowerCase());
  if (!home) notFound();

  const readOnly = owner.state !== 'active' && owner.site.clientProduct.status !== 'paused';
  const title = typeof (home.data.title as { es?: unknown } | undefined)?.es === 'string' && (home.data.title as { es: string }).es.trim();

  return (
    <div>
      <PageHeading eyebrow={`Cartera · ${home.ref}`} title={title || 'Casa sin título'} />
      <CarteraHomeEditor
        home={{
          ...home,
          readOnly,
          graceEndsAt: owner.state === 'grace' ? (owner.graceEndsAt?.toISOString() ?? null) : null,
          agents: siteAgents(owner.site),
          statuses: HOME_STATUSES[home.operation],
          statusLabels: STATUS_LABELS,
        }}
      />
    </div>
  );
}
