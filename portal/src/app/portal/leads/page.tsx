import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { ProductPitch } from '@/components/portal/ProductPitch';
import { SelfServeProductCard, type SelfServeTierOption } from '@/components/portal/SelfServeProductCard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Captación con IA · Portal Kairikos',
  robots: { index: false, follow: false },
};

// =============================================================================
// Real, standalone content page for the 'leads' product ("Sistema IA de
// captación" in the catalog, "Captación con IA" in the portal nav — see
// portal-nav.ts). A real folder (not the generic /portal/[product]
// catch-all), same reasoning as /portal/web: this product now has real
// content (a descriptive pitch + a working purchase CTA) worth its own
// route, per the catch-all's own comment about when a product graduates
// out of it. No entry needed in that page's CANONICAL_HREF map — the
// folder name already matches the product code.
//
// Unlike 'web' (custom-quoted), 'leads' is sold at a fixed price via the
// same self-serve Stripe checkout used on /portal/productos — this page
// reuses SelfServeProductCard rather than inventing a second purchase
// flow.
// =============================================================================

function tierLabel(tier: string): string {
  return tier === 'standard' ? 'Estándar' : tier.charAt(0).toUpperCase() + tier.slice(1);
}

export default async function PortalLeadsPage() {
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/login?next=/portal/leads');
  }

  const hasLeads =
    isDatabaseConfigured && resolved.source === 'database'
      ? await isProductContracted(prisma, resolved.clientId, 'leads')
      : false;

  if (!hasLeads) {
    let tiers: SelfServeTierOption[] = [];
    let pendingProductId: string | null = null;
    if (isDatabaseConfigured && resolved.source === 'database') {
      const [products, pendingRow] = await Promise.all([
        prisma.product.findMany({
          where: { code: 'leads', isActive: true },
          orderBy: { priceCents: 'asc' },
          select: { id: true, tier: true, priceCents: true, setupFeeCents: true, currency: true },
        }),
        prisma.clientProduct.findFirst({
          where: { clientId: resolved.clientId, status: 'pending_payment', product: { code: 'leads' } },
          select: { productId: true },
        }),
      ]);
      tiers = products.map((p) => ({
        productId: p.id,
        tier: p.tier,
        tierLabel: tierLabel(p.tier),
        priceCents: p.priceCents,
        setupFeeCents: p.setupFeeCents,
        currency: p.currency,
      }));
      pendingProductId = pendingRow?.productId ?? null;
    }

    return (
      <div className="space-y-6">
        <PageHeading
          eyebrow="Portal"
          title="Captación con IA"
          description="Un sistema de IA que prioriza tus contactos, para que tu equipo se enfoque en los que realmente van a convertir."
        />
        <ProductPitch
          tagline="Menos tiempo filtrando consultas a mano, más tiempo cerrando ventas."
          features={[
            'La IA analiza cada contacto entrante y lo prioriza según su probabilidad de convertirse en cliente.',
            'Tu equipo ve primero los leads que más importan, no una lista sin ordenar.',
            'Configuración incluida en el alta — no hace falta que tu equipo aprenda nada nuevo.',
          ]}
        >
          {isDatabaseConfigured && resolved.source === 'database' && tiers.length > 0 ? (
            pendingProductId ? (
              <SelfServeProductCard code="leads" label="Captación con IA" status="pending" productId={pendingProductId} />
            ) : (
              <SelfServeProductCard code="leads" label="Captación con IA" status="available" tiers={tiers} />
            )
          ) : (
            <EmptyState
              title="No disponible en modo demo"
              description="La contratación de productos requiere una cuenta real conectada a facturación."
            />
          )}
        </ProductPitch>
      </div>
    );
  }

  const clientProduct = await prisma.clientProduct.findFirst({
    where: { clientId: resolved.clientId, status: 'active', product: { code: 'leads' } },
    select: { onboardingState: true },
  });
  const statusLabel = clientProduct?.onboardingState === 'live' ? 'En producción' : 'Configurando';

  return (
    <div className="space-y-6">
      <PageHeading eyebrow="Portal" title="Captación con IA" description={`Estado: ${statusLabel}.`} />
      <EmptyState
        title="La gestión detallada de este producto se coordina por soporte"
        description="Esta sección todavía no tiene su propio panel en el portal. Si necesitas hacer cambios o tienes preguntas sobre tu plan, escríbenos."
        action={
          <Link href="/portal/support" className="btn-primary" data-testid="leads-support-link">
            Contactar soporte
          </Link>
        }
      />
    </div>
  );
}
