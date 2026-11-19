import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { CarteraPanel } from '@/components/portal/CarteraPanel';
import { findSiteForOwner } from '@/lib/cartera/site';
import { listHomesForPanel } from '@/lib/cartera/homes';
import { loadPublicationForPanel } from '@/lib/cartera/publish';
import { HOME_STATUSES, STATUS_LABELS } from '@/lib/cartera/home-rules';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Cartera',
  robots: { index: false, follow: false },
};

// =============================================================================
// Cartera de Signature inmobiliaria — el panel de la agencia (/portal/cartera).
//
// PR 2 («Portal, panel»): la pestaña Casas (tabla, filtros y «Nueva casa») y
// la ficha de cada casa (/portal/cartera/<id>). Contactos, Publicación y
// Exportar llegan en sus PR. Ver docs/fase1-cartera.md de la plantilla web.
//
// En el menú sale solo a quien tiene la contratación (portalNavFor, en
// portal-nav.ts; lo decide el layout con findSiteForOwner). En la gracia de
// una baja, o suspendida sin estar en pausa, el panel es de solo lectura,
// como el de villas: las rutas de escritura responden 403 'read_only'.
// =============================================================================

export default async function CarteraPage() {
  await requirePortalSession();
  const resolved = isDatabaseConfigured ? await resolveClientFromSession() : null;
  const owner = resolved?.source === 'database' ? await findSiteForOwner(prisma, resolved.clientId) : null;

  if (!owner) {
    return (
      <div>
        <PageHeading eyebrow="Inmobiliaria" title="Cartera" />
        <EmptyState
          title="No está activa en tu cuenta"
          description="La cartera (tus casas en venta y alquiler, publicadas solas en tu web Signature) se contrata con tu web."
          action={
            <Link href="/portal/support" className="btn-primary">
              Hablar con soporte
            </Link>
          }
        />
      </div>
    );
  }

  const readOnly = owner.state !== 'active' && owner.site.clientProduct.status !== 'paused';
  const [homes, publication] = await Promise.all([
    listHomesForPanel(prisma, owner.site.id),
    loadPublicationForPanel(prisma, owner.site, owner.site.clientProduct.status),
  ]);

  return (
    <div>
      <PageHeading
        eyebrow="Inmobiliaria"
        title="Cartera"
        description="Tus casas en venta y en alquiler. Lo que guardes aquí llega solo a tu web; una casa sale publicada cuando no es un borrador y no le falta nada."
      />
      <CarteraPanel
        data={{
          readOnly,
          graceEndsAt: owner.state === 'grace' ? (owner.graceEndsAt?.toISOString() ?? null) : null,
          statusLabels: STATUS_LABELS,
          statuses: { venta: HOME_STATUSES.venta, alquiler: HOME_STATUSES.alquiler },
          homes,
          publication,
        }}
      />
    </div>
  );
}
