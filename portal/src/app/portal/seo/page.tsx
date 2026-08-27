import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isProductContracted } from '@/lib/client-product-access';
import { PageHeading } from '@/components/portal/PageHeading';
import { ProductPitch } from '@/components/portal/ProductPitch';
import { EmptyState } from '@/components/portal/EmptyState';
import { SelfServeProductCard, type SelfServeTierOption } from '@/components/portal/SelfServeProductCard';
import { SeoProfileCard } from '@/components/portal/SeoProfileCard';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'SEO con IA',
  robots: { index: false, follow: false },
};

// =============================================================================
// SEO con IA, Fase A — the client's own onboarding page. A single tier
// ('standard'), so no month/tier picker like /portal/llamadas — just the
// pitch when not contracted, or the SeoProfileCard form once it is.
// =============================================================================

export default async function PortalSeoPage() {
  await requirePortalSession();
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/login?next=/portal/seo');
  }

  const hasSeo =
    isDatabaseConfigured && resolved.source === 'database'
      ? await isProductContracted(prisma, resolved.clientId, 'seo')
      : false;

  if (!hasSeo) {
    let tiers: SelfServeTierOption[] = [];
    let pendingProductId: string | null = null;
    if (isDatabaseConfigured && resolved.source === 'database') {
      const [products, pendingRow] = await Promise.all([
        prisma.product.findMany({
          where: { code: 'seo', isActive: true },
          orderBy: { priceCents: 'asc' },
          select: { id: true, tier: true, priceCents: true, setupFeeCents: true, currency: true },
        }),
        prisma.clientProduct.findFirst({
          where: { clientId: resolved.clientId, status: 'pending_payment', product: { code: 'seo' } },
          select: { productId: true },
        }),
      ]);
      tiers = products.map((p) => ({
        productId: p.id,
        tier: p.tier,
        tierLabel: 'Estándar',
        priceCents: p.priceCents,
        setupFeeCents: p.setupFeeCents,
        currency: p.currency,
      }));
      pendingProductId = pendingRow?.productId ?? null;
    }

    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Portal" title="SEO con IA" />
        <ProductPitch
          tagline="Contenido optimizado para SEO, sin que tengas que escribir ni interpretar nada."
          features={[
            'Redactamos artículos optimizados para tu sitio, mes a mes.',
            'Investigamos qué palabras clave le traerían tráfico real a tu negocio.',
            'Un informe mensual te enseña cómo va tu posicionamiento en Google.',
            'Nada se publica sin que nuestro equipo lo revise primero.',
          ]}
          priceNote="199 €/mes, sin alta."
        >
          {tiers.length > 0 ? (
            pendingProductId ? (
              <SelfServeProductCard code="seo" label="SEO con IA" status="pending" productId={pendingProductId} />
            ) : (
              <SelfServeProductCard code="seo" label="SEO con IA" status="available" tiers={tiers} />
            )
          ) : (
            <EmptyState
              title="Habla con nosotros"
              description="Todavía no se puede contratar solo desde el portal. Escríbenos y lo dejamos montado."
              action={
                <Link href="/portal/support" className="btn-primary">
                  Quiero información
                </Link>
              }
            />
          )}
        </ProductPitch>
      </div>
    );
  }

  const profile = await prisma.seoProfile.findFirst({
    where: { clientId: resolved.clientId },
    select: {
      businessDescription: true,
      targetAudience: true,
      toneOfVoice: true,
      siteUrl: true,
      cmsType: true,
    },
  });

  return (
    <div className="space-y-6">
      <PageHeading eyebrow="Portal" title="SEO con IA" description="Cuéntanos de tu negocio para empezar." />
      <SeoProfileCard profile={profile} />
    </div>
  );
}
