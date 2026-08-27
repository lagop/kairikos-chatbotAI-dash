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
//
// Fase B adds the Search Console connection status + connect link — same
// query-param-driven connected/connect_error pattern as /portal/resenas's
// own Google OAuth flow (WP-21).
// =============================================================================

const CONNECT_ERROR_LABEL: Record<string, string> = {
  csrf: 'No se pudo verificar la solicitud — inténtalo de nuevo.',
  token_exchange_failed: 'Google no pudo completar la conexión — inténtalo de nuevo.',
  no_site_url: 'Indica primero la URL de tu sitio arriba, antes de conectar Search Console.',
  site_not_verified:
    'Esa cuenta de Google no tiene tu sitio verificado en Search Console. Verifícalo en Search Console y vuelve a intentarlo.',
  no_tenant: 'No pudimos completar la conexión — escríbenos a soporte.',
  not_configured: 'La conexión con Google no está disponible en este momento.',
  not_available_in_dev_mode: 'La conexión con Google no está disponible en modo demo.',
  forbidden: 'Este producto no está incluido en tu plan.',
};

export default async function PortalSeoPage({
  searchParams,
}: {
  searchParams?: { connected?: string; connect_error?: string };
}) {
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

  const connection = await prisma.googleSeoConnection.findUnique({
    where: { clientId: resolved.clientId },
    select: { status: true, searchConsoleSiteUrl: true, connectedAt: true },
  });

  return (
    <div className="space-y-6">
      <PageHeading eyebrow="Portal" title="SEO con IA" description="Cuéntanos de tu negocio para empezar." />
      <SeoProfileCard profile={profile} />

      <section className="card space-y-3" aria-label="Search Console" data-testid="seo-search-console-card">
        <div>
          <p className="text-sm font-semibold">Google Search Console</p>
          <p className="text-xs text-kairikos-muted">
            Conecta tu cuenta de Google para que preparemos tu informe mensual de posicionamiento.
          </p>
        </div>

        {searchParams?.connected === '1' ? (
          <p className="text-sm text-kairikos-success" data-testid="seo-search-console-connected-banner">
            Conectado correctamente.
          </p>
        ) : null}
        {searchParams?.connect_error ? (
          <p className="text-sm text-kairikos-danger" data-testid="seo-search-console-error-banner">
            {CONNECT_ERROR_LABEL[searchParams.connect_error] ?? 'No se pudo completar la conexión con Google.'}
          </p>
        ) : null}

        {connection?.status === 'active' ? (
          <p className="text-sm" data-testid="seo-search-console-status">
            Conectado a <span className="font-medium">{connection.searchConsoleSiteUrl}</span> desde el{' '}
            {connection.connectedAt.toLocaleDateString('es-ES')}.
          </p>
        ) : connection?.status === 'needs_reconnect' ? (
          <div className="space-y-2">
            <p className="text-sm text-kairikos-danger" data-testid="seo-search-console-status">
              La conexión dejó de funcionar — vuelve a conectarla.
            </p>
            <a href="/api/portal/seo/oauth/start" className="btn-primary" data-testid="seo-search-console-connect">
              Reconectar Search Console
            </a>
          </div>
        ) : (
          <a href="/api/portal/seo/oauth/start" className="btn-primary" data-testid="seo-search-console-connect">
            Conectar Search Console
          </a>
        )}
      </section>
    </div>
  );
}
