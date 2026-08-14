import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { PRODUCT_CODES, PRODUCT_CATALOGS, type ProductCode } from '@/lib/catalogs';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';

export const dynamic = 'force-dynamic';

// =============================================================================
// Generic home page for a contracted product that doesn't have its own,
// richer page yet — today that's Web/Leads/SEO. Chatbot (/portal/status)
// and Reviews (/portal/resenas) predate this route and keep their own
// folders (redirected to below), because a static folder always wins
// over a dynamic [product] segment in the App Router, and neither is
// named to match its product code anyway.
//
// Deliberately minimal: kairikos.com has no dedicated feature page for
// Web/Leads/SEO the way it does for Reviews
// (kairikos.com/resenas-google) to build real functionality against —
// this shows real state (contracted or not) and points the client at
// support rather than inventing dashboards/metrics that don't exist.
// When a product gets real per-product functionality, its page moves
// out of this generic handler into its own route, the same way Reviews
// already did.
// =============================================================================

const CANONICAL_HREF: Readonly<Partial<Record<string, string>>> = {
  chatbot: '/portal/status',
  reviews: '/portal/resenas',
};

function isProductCode(value: string): value is ProductCode {
  return (PRODUCT_CODES as readonly string[]).includes(value);
}

export async function generateMetadata({ params }: { params: { product: string } }): Promise<Metadata> {
  const label = isProductCode(params.product) ? PRODUCT_CATALOGS[params.product].label : 'Producto';
  return {
    title: `${label} · Portal Kairikos`,
    robots: { index: false, follow: false },
  };
}

export default async function PortalProductPage({ params }: { params: { product: string } }) {
  const canonical = CANONICAL_HREF[params.product];
  if (canonical) {
    redirect(canonical);
  }
  if (!isProductCode(params.product)) {
    notFound();
  }
  const productCode = params.product;

  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect(`/portal/login?next=/portal/${productCode}`);
  }

  const label = PRODUCT_CATALOGS[productCode].label;

  // Same gate used everywhere else in the portal (wizard routes,
  // /portal/resenas) — the single source of truth for "does this client
  // have this product", not re-derived here.
  const hasProduct =
    isDatabaseConfigured && resolved.source === 'database'
      ? await isProductContracted(prisma, resolved.clientId, productCode)
      : false;

  if (!hasProduct) {
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Portal" title={label} />
        <EmptyState
          title="No incluido en tu plan actual"
          description="Este producto no está contratado en tu cuenta. Puedes añadirlo desde el catálogo de autoservicio."
          action={
            <Link href="/portal/productos" className="btn-primary" data-testid="product-page-add-link">
              Ver productos disponibles
            </Link>
          }
        />
      </div>
    );
  }

  const clientProduct = await prisma.clientProduct.findFirst({
    where: { clientId: resolved.clientId, status: 'active', product: { code: productCode } },
    select: { onboardingState: true },
  });
  const statusLabel = clientProduct?.onboardingState === 'live' ? 'En producción' : 'Configurando';

  return (
    <div className="space-y-6">
      <PageHeading eyebrow="Portal" title={label} description={`Estado: ${statusLabel}.`} />
      <EmptyState
        title="La gestión detallada de este producto se coordina por soporte"
        description="Esta sección todavía no tiene su propio panel en el portal. Si necesitas hacer cambios o tienes preguntas sobre tu plan, escríbenos."
        action={
          <Link href="/portal/support" className="btn-primary" data-testid="product-page-support-link">
            Contactar soporte
          </Link>
        }
      />
    </div>
  );
}
