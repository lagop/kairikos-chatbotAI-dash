import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { findSiteForOwner } from '@/lib/cartera/site';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Cartera',
  robots: { index: false, follow: false },
};

// =============================================================================
// Cartera de Signature inmobiliaria — el panel de la agencia (/portal/cartera).
//
// PR 1 («Portal, base»): solo el esqueleto. El panel de verdad (casas, ficha,
// fotos, contactos, publicación y exportación, en el estilo de VillasPanel)
// llega en el PR 2. Ver docs/fase1-cartera.md de la plantilla web.
//
// En el menú sale solo a quien tiene la contratación (portalNavFor, en
// portal-nav.ts; lo decide el layout con findSiteForOwner).
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

  const [ventas, alquileres] = await Promise.all([
    prisma.carteraHome.count({ where: { siteId: owner.site.id, operation: 'venta' } }),
    prisma.carteraHome.count({ where: { siteId: owner.site.id, operation: 'alquiler' } }),
  ]);

  return (
    <div>
      <PageHeading eyebrow="Inmobiliaria" title="Cartera" />
      <EmptyState
        title="En construcción"
        description={`Aquí darás de alta y editarás tus casas, y tu web se actualizará sola. Ahora mismo hay ${ventas} en venta y ${alquileres} en alquiler.`}
        action={
          <Link href="/portal/support" className="btn-primary">
            Hablar con soporte
          </Link>
        }
      />
    </div>
  );
}
