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
import { SeoTrendChart, type SeoTrendPoint } from '@/components/portal/SeoTrendChart';
import { SeoAnalyticsPicker } from '@/components/portal/SeoAnalyticsPicker';
import { SeoKeywordsCard } from '@/components/portal/SeoKeywordsCard';
import { SeoRecommendationsCard } from '@/components/portal/SeoRecommendationsCard';
import { SeoDraftReviewCard } from '@/components/portal/SeoDraftReviewCard';
import { buildKeywordTrends } from '@/lib/seo-keywords';
import { buildRecommendations, parseAuditResult } from '@/lib/seo-recommendations';
import { computeAutoPublishDeadline } from '@/lib/seo-draft-auto-publish';

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
//
// GA4/Analytics (deferred out of the original Fase B, built later) adds
// a second, separate connection card with its own ga_connected/
// ga_connect_error query params — it needs an extra step Search Console
// doesn't (picking which GA4 property is theirs, see
// SeoAnalyticsPicker), so it's its own section rather than folded into
// the Search Console one.
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

const WP_CONNECT_ERROR_LABEL: Record<string, string> = {
  csrf: 'No se pudo verificar la solicitud — inténtalo de nuevo.',
  no_site_url: 'Indica primero la URL de tu sitio arriba, antes de conectar WordPress.',
  not_wordpress: 'Esta conexión automática solo funciona si tu sitio usa WordPress.',
  invalid_site_url: 'La URL de tu sitio no parece válida — revísala arriba y vuelve a intentarlo.',
  wordpress_rejected: 'No se completó la conexión en WordPress.',
  wordpress_incomplete_response: 'WordPress no devolvió lo necesario para conectar — inténtalo de nuevo.',
  no_profile: 'No pudimos completar la conexión — escríbenos a soporte.',
  internal_error: 'No pudimos completar la conexión — escríbenos a soporte.',
  not_available_in_dev_mode: 'La conexión con WordPress no está disponible en modo demo.',
  forbidden: 'Este producto no está incluido en tu plan.',
};

const GA_CONNECT_ERROR_LABEL: Record<string, string> = {
  csrf: 'No se pudo verificar la solicitud — inténtalo de nuevo.',
  token_exchange_failed: 'Google no pudo completar la conexión — inténtalo de nuevo.',
  no_tenant: 'No pudimos completar la conexión — escríbenos a soporte.',
  not_configured: 'La conexión con Google Analytics no está disponible en este momento.',
  not_available_in_dev_mode: 'La conexión con Google no está disponible en modo demo.',
  forbidden: 'Este producto no está incluido en tu plan.',
};

export default async function PortalSeoPage({
  searchParams,
}: {
  searchParams?: {
    connected?: string;
    connect_error?: string;
    ga_connected?: string;
    ga_connect_error?: string;
    wp_connected?: string;
    wp_connect_error?: string;
  };
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
      id: true,
      businessDescription: true,
      targetAudience: true,
      toneOfVoice: true,
      siteUrl: true,
      cmsType: true,
      // Fase 3.2 — la auditoría técnica existía desde Fase A pero solo la
      // veía un operador, y en crudo. Aquí se traduce a recomendaciones.
      lastAuditResult: true,
      // Fase 5 — para decidir si se enseña la tarjeta de conexión de
      // WordPress y con qué estado. Nunca el cifrado en sí: solo si
      // existe.
      wordpressUrl: true,
      wordpressAppPasswordCiphertext: true,
    },
  });

  const hasWordPressAppPassword = Boolean(profile?.wordpressAppPasswordCiphertext);

  // Fase 3.1 — las palabras que el cliente persigue y cómo van.
  const keywordTrends = profile ? await buildKeywordTrends(prisma, resolved.clientId) : [];

  // Fase 3.2 — señales crudas del audit → qué hacer, en su idioma.
  const audit = profile ? parseAuditResult(profile.lastAuditResult) : null;
  const recommendations = audit ? buildRecommendations(audit) : null;

  // SEO con IA, Fase C/6 — el cliente solo ve dos estados: PUBLISHED
  // (ya en su web) y, desde Fase 6, PENDING_CLIENT_REVIEW (el operador
  // ya lo aprobó internamente, le toca a él la última palabra antes de
  // que salga en vivo). 'drafted', 'rejected' y 'publish_failed' siguen
  // siendo operator-only (ver SeoContentDraftsPanel) — jerga interna
  // sobre la que el cliente no puede ni debe actuar.
  const publishedArticles = profile
    ? await prisma.seoContentDraft.findMany({
        where: { profileId: profile.id, status: 'published' },
        orderBy: { publishedAt: 'desc' },
        select: { id: true, title: true, publishedAt: true, wordpressPostUrl: true },
      })
    : [];

  const draftsForReview = profile
    ? await prisma.seoContentDraft.findMany({
        where: { profileId: profile.id, status: 'pending_client_review' },
        orderBy: { clientReviewRequestedAt: 'asc' },
        select: { id: true, title: true, bodyHtml: true, targetKeyword: true, metaDescription: true, clientReviewRequestedAt: true },
      }).then((rows) =>
        rows.map((d) => ({
          id: d.id,
          title: d.title,
          bodyHtml: d.bodyHtml,
          targetKeyword: d.targetKeyword,
          metaDescription: d.metaDescription,
          autoPublishDeadline:
            computeAutoPublishDeadline({ status: 'pending_client_review', clientReviewRequestedAt: d.clientReviewRequestedAt })?.toISOString() ??
            null,
        })),
      )
    : [];

  const connection = await prisma.googleSeoConnection.findUnique({
    where: { clientId: resolved.clientId },
    select: { id: true, status: true, searchConsoleSiteUrl: true, connectedAt: true },
  });

  let trendPoints: SeoTrendPoint[] = [];
  if (connection?.status === 'active') {
    const metrics = await prisma.seoSearchConsoleMetric.findMany({
      where: { connectionId: connection.id },
      orderBy: { date: 'asc' },
      select: { date: true, clicks: true, impressions: true },
    });
    trendPoints = metrics.map((m) => ({
      date: m.date.toISOString().slice(0, 10),
      primary: m.clicks,
      secondary: m.impressions,
    }));
  }

  const analyticsConnection = await prisma.googleAnalyticsConnection.findUnique({
    where: { clientId: resolved.clientId },
    select: { id: true, status: true, propertyDisplayName: true, connectedAt: true },
  });

  let analyticsTrendPoints: SeoTrendPoint[] = [];
  if (analyticsConnection?.status === 'active') {
    const metrics = await prisma.seoAnalyticsMetric.findMany({
      where: { connectionId: analyticsConnection.id },
      orderBy: { date: 'asc' },
      select: { date: true, users: true, sessions: true },
    });
    analyticsTrendPoints = metrics.map((m) => ({
      date: m.date.toISOString().slice(0, 10),
      primary: m.users,
      secondary: m.sessions,
    }));
  }

  return (
    <div className="space-y-6">
      <PageHeading eyebrow="Portal" title="SEO con IA" description="Cuéntanos de tu negocio para empezar." />
      <SeoProfileCard profile={profile} />

      {profile?.cmsType === 'wordpress' ? (
        <section className="card space-y-3" aria-label="Conexión con WordPress" data-testid="seo-wordpress-card">
          <div>
            <p className="text-sm font-semibold">Publicar en tu WordPress</p>
            <p className="text-xs text-kairikos-muted">
              Conéctate con tu propio usuario de WordPress para que podamos publicar los artículos directamente
              en tu sitio, sin que tengas que pasarle ninguna contraseña a nadie.
            </p>
          </div>

          {searchParams?.wp_connected === '1' ? (
            <p className="text-sm text-kairikos-success" data-testid="seo-wordpress-connected-banner">
              Conectado correctamente.
            </p>
          ) : null}
          {searchParams?.wp_connect_error ? (
            <p className="text-sm text-kairikos-danger" data-testid="seo-wordpress-error-banner">
              {WP_CONNECT_ERROR_LABEL[searchParams.wp_connect_error] ?? 'No se pudo completar la conexión con WordPress.'}
            </p>
          ) : null}

          {hasWordPressAppPassword ? (
            <div className="space-y-2">
              <p className="text-sm" data-testid="seo-wordpress-status">
                Conectado{profile.wordpressUrl ? <> a <span className="font-medium">{profile.wordpressUrl}</span></> : null}.
              </p>
              <a href="/api/portal/seo/wordpress/connect" className="btn-ghost" data-testid="seo-wordpress-reconnect">
                Volver a conectar
              </a>
            </div>
          ) : (
            <a href="/api/portal/seo/wordpress/connect" className="btn-primary" data-testid="seo-wordpress-connect">
              Conectar WordPress
            </a>
          )}
        </section>
      ) : null}

      {profile ? <SeoKeywordsCard trends={keywordTrends} /> : null}

      {recommendations ? (
        <SeoRecommendationsCard recommendations={recommendations} checkedAt={audit?.checkedAt ?? null} />
      ) : null}

      <SeoDraftReviewCard drafts={draftsForReview} />

      <section className="card space-y-3" aria-label="Tus artículos" data-testid="seo-articles-card">
        <div>
          <p className="text-sm font-semibold">Tus artículos</p>
          <p className="text-xs text-kairikos-muted">Artículos que hemos redactado y publicado en tu sitio.</p>
        </div>

        {publishedArticles.length === 0 ? (
          <p className="text-sm text-kairikos-muted" data-testid="seo-articles-empty">
            Todavía no hay artículos publicados. En cuanto el primero esté listo y revisado, aparecerá aquí.
          </p>
        ) : (
          <ul className="space-y-3" data-testid="seo-articles-list">
            {publishedArticles.map((article) => (
              <li key={article.id} className="rounded-xl border border-kairikos-border p-3" data-testid="seo-article-item">
                <p className="text-sm font-semibold">{article.title}</p>
                <div className="mt-1 flex items-center justify-between gap-3 text-xs text-kairikos-muted">
                  <span>Publicado el {article.publishedAt?.toLocaleDateString('es-ES')}</span>
                  {article.wordpressPostUrl ? (
                    <a href={article.wordpressPostUrl} target="_blank" rel="noreferrer" className="font-medium text-kairikos-accent underline">
                      Ver artículo
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

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
          <div className="space-y-4">
            <p className="text-sm" data-testid="seo-search-console-status">
              Conectado a <span className="font-medium">{connection.searchConsoleSiteUrl}</span> desde el{' '}
              {connection.connectedAt.toLocaleDateString('es-ES')}.
            </p>
            <div>
              <p className="mb-2 text-sm font-semibold">Últimos 30 días</p>
              <SeoTrendChart points={trendPoints} primaryLabel="Clics" secondaryLabel="Impresiones" />
            </div>
          </div>
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

      <section className="card space-y-3" aria-label="Google Analytics" data-testid="seo-analytics-card">
        <div>
          <p className="text-sm font-semibold">Google Analytics</p>
          <p className="text-xs text-kairikos-muted">Conecta tu cuenta de Google Analytics para completar tu informe.</p>
        </div>

        {searchParams?.ga_connected === '1' ? (
          <p className="text-sm text-kairikos-success" data-testid="seo-analytics-connected-banner">
            Conectado correctamente.
          </p>
        ) : null}
        {searchParams?.ga_connect_error ? (
          <p className="text-sm text-kairikos-danger" data-testid="seo-analytics-error-banner">
            {GA_CONNECT_ERROR_LABEL[searchParams.ga_connect_error] ?? 'No se pudo completar la conexión con Google.'}
          </p>
        ) : null}

        {analyticsConnection?.status === 'active' ? (
          <div className="space-y-4">
            <p className="text-sm" data-testid="seo-analytics-status">
              Conectado a <span className="font-medium">{analyticsConnection.propertyDisplayName}</span> desde el{' '}
              {analyticsConnection.connectedAt.toLocaleDateString('es-ES')}.
            </p>
            <div>
              <p className="mb-2 text-sm font-semibold">Últimos 30 días</p>
              <SeoTrendChart points={analyticsTrendPoints} primaryLabel="Usuarios" secondaryLabel="Sesiones" />
            </div>
          </div>
        ) : analyticsConnection?.status === 'pending_property_selection' ? (
          <SeoAnalyticsPicker />
        ) : analyticsConnection?.status === 'needs_reconnect' ? (
          <div className="space-y-2">
            <p className="text-sm text-kairikos-danger" data-testid="seo-analytics-status">
              La conexión dejó de funcionar — vuelve a conectarla.
            </p>
            <a href="/api/portal/seo/analytics/oauth/start" className="btn-primary" data-testid="seo-analytics-connect">
              Reconectar Google Analytics
            </a>
          </div>
        ) : (
          <a href="/api/portal/seo/analytics/oauth/start" className="btn-primary" data-testid="seo-analytics-connect">
            Conectar Google Analytics
          </a>
        )}
      </section>
    </div>
  );
}
