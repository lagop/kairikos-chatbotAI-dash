import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChatbotStatusCard } from '@/components/portal/ChatbotStatusCard';
import { OnboardingTimeline } from '@/components/portal/OnboardingTimeline';
import { PageHeading } from '@/components/portal/PageHeading';
import { ProductSummaryCard } from '@/components/portal/ProductSummaryCard';
import { getSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { isDatabaseConfigured, prisma } from '@/lib/prisma';
import { getDashboardData } from '@/lib/dashboard-data';
import { CHATBOT_PRODUCT_CODE } from '@/lib/wizard-catalog';
import { PRODUCT_CODES, PRODUCT_CATALOGS, type ProductCode } from '@/lib/catalogs';
import { logError } from '@/lib/observability';
import type { OnboardingStatus } from '@/types/portal';

function isProductCode(value: string): value is ProductCode {
  return (PRODUCT_CODES as readonly string[]).includes(value);
}

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Resumen',
  description: 'Estado de tus productos Kairikos y próximos pasos del onboarding.',
  alternates: { canonical: '/portal' },
  robots: { index: false, follow: false },
};

// =============================================================================
// WP-08 / WP-17 — this is the real client-facing summary screen: PORTAL_NAV
// (WP-04's canonical nav list) links "Resumen" here, not to the orphaned
// /portal/dashboard route (now a redirect — see that file). Before WP-17
// this page ran its own independent Prisma reads + its own
// fallbackRate/escalationRate = 0 shortcut, completely bypassing
// dashboard-data.ts — the exact CONFIRMADO audit finding (this page showed
// 0%/0% while /portal/status showed a stale 8%/12% for the same client at
// the same moment). Now this page renders exactly what getDashboardData()
// decided, same as /portal/status — nowhere recomputes those numbers.
//
// One ProductSummaryCard per active ClientProduct. A single-product
// client (today's overwhelming majority) sees exactly one card — the
// multi-product grid degrades to "one card" instead of a page redesign,
// per the WP-17 AC that multi-product must not penalize that case.
// =============================================================================
export default async function PortalHome({
  searchParams,
}: {
  searchParams: { checkout?: string };
}) {
  let session;
  try {
    session = await getSession();
  } catch (err) {
    logError('portal_home.get_session', err, { route: '/portal' });
    redirect('/portal/login');
  }
  if (!session.hasClientAccess) {
    const target = session.reason === 'no_session' ? '/portal/login' : '/portal/sin-acceso';
    redirect(target);
  }
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/sin-acceso');
  }

  const data = await getDashboardData(resolved);

  // WP-30 — a lightweight, best-effort "products you could add" teaser.
  // Deliberately NOT folded into getDashboardData()/DashboardData: that
  // function's fallback chain (prisma → /api/portal/me → mock) exists to
  // guarantee the client's OWN identity and products render correctly
  // under partial outages (see the CONFIRMADO audit history above) — this
  // is a secondary discovery surface, not load-bearing data, so it stays
  // isolated with its own try/catch and never blocks or degrades the rest
  // of the page. /portal/productos re-derives the authoritative version
  // of this same list (including in-flight 'pending_payment' rows) before
  // letting the client actually start a checkout.
  let availableProductCodes: string[] = [];
  if (isDatabaseConfigured && resolved.source === 'database') {
    try {
      const contractedCodes = new Set<string>(data.products.map((p) => p.productCode));
      const allActiveProducts = await prisma.product.findMany({ where: { isActive: true }, select: { code: true } });
      availableProductCodes = Array.from(new Set(allActiveProducts.map((p) => p.code))).filter(
        (code) => !contractedCodes.has(code),
      );
    } catch (err) {
      logError('portal_home.available_products', err, { route: '/portal', clientId: resolved.clientId });
    }
  }

  // WP-08 AC, carried over from /portal/dashboard: a visitor whose
  // Supabase env looks like dev-mock but whose DATABASE_URL is genuinely
  // configured and reachable is a real half-configured-environment class,
  // not a developer running `next dev` with nothing set up. Surface it as
  // a banner instead of quietly rendering MOCK_CLIENT as if it were real.
  const showMockDiagnosticBanner = data.source === 'mock_dev' && isDatabaseConfigured;

  const chatbot = data.products.find((p) => p.productCode === CHATBOT_PRODUCT_CODE);
  // KAIA-11956 — Reseñas de Google is not sellable yet (WP-15's seed
  // marks it inactive), but customers reported the section was
  // undiscoverable when it was missing entirely from the home screen.
  // Every client who doesn't already have it contracted gets an honest
  // "No incluido" card (never "Pronto" — the board flagged that as a
  // promise Kairikos wasn't ready to make) instead of silence. This is
  // deliberately NOT a ProductSummaryCard: those only render for
  // products the client actually has.
  const hasReviews = data.products.some((p) => p.productCode === 'reviews');
  const chatbotSummary = chatbot?.activity
    ? {
        spaceId: `spc_${data.client.id}`,
        status: chatbot.onboardingState as OnboardingStatus,
        goLiveDate: chatbot.goLiveAt,
        last7Days: chatbot.activity.last7Days,
      }
    : null;

  return (
    <div className="space-y-6">
      {showMockDiagnosticBanner ? (
        <div
          className="rounded-xl border border-kairikos-warning/40 bg-kairikos-warning/10 px-4 py-3 text-sm text-kairikos-text"
          role="status"
          data-testid="dashboard-mock-diagnostic-banner"
        >
          <p className="font-semibold">Mostrando datos de ejemplo</p>
          <p className="mt-1 text-kairikos-muted">
            La base de datos está configurada, pero esta sesión no ha podido resolver un cliente real. Un
            operador ya ha sido avisado.
          </p>
        </div>
      ) : null}

      {searchParams.checkout === 'success' ? (
        <div
          className="rounded-xl border border-kairikos-success/40 bg-kairikos-success/10 px-4 py-3 text-sm text-kairikos-text"
          role="status"
          data-testid="checkout-success-banner"
        >
          <p className="font-semibold">Pago recibido</p>
          <p className="mt-1 text-kairikos-muted">
            Estamos confirmando tu pago y activando el producto — puede tardar unos segundos en aparecer aquí.
          </p>
        </div>
      ) : null}

      <PageHeading
        eyebrow="Resumen"
        title={data.client.name}
        description="Aquí verás el estado de tus productos Kairikos y los próximos pasos del onboarding."
        actions={
          <Link href="/portal/support" className="btn-ghost">Contactar soporte</Link>
        }
      />
      <span data-testid="dashboard-client-name" data-dashboard-source={data.source} hidden>
        {data.client.name}
      </span>

      {data.products.length === 0 ? (
        <div className="card text-sm text-kairikos-muted">
          Todavía no tienes productos activos en tu cuenta. Si crees que esto es un error, contacta con soporte.
        </div>
      ) : (
        <div
          className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3"
          aria-label="Tus productos"
          data-testid="product-grid"
        >
          {data.products.map((product) => (
            <ProductSummaryCard key={product.productCode} product={product} />
          ))}
        </div>
      )}

      {chatbotSummary ? (
        <>
          <ChatbotStatusCard summary={chatbotSummary} previous7Days={chatbot?.activity?.previous7Days} />
          <section className="card" aria-label="Progreso del onboarding del chatbot">
            <header className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Onboarding del chatbot</h2>
              <Link href="/portal/onboarding" className="text-sm text-kairikos-accent2 hover:underline">
                Ver todo
              </Link>
            </header>
            <OnboardingTimeline rows={chatbot?.timeline ?? []} />
          </section>
        </>
      ) : null}

      {!hasReviews ? (
        <section
          className="card"
          aria-labelledby="resenas-resumen"
          data-testid="resenas-summary-card"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 id="resenas-resumen" className="text-lg font-semibold">
              Reseñas de Google
            </h2>
            <span className="pill-muted">No incluido</span>
          </div>
          <p className="text-sm text-kairikos-muted">
            La gestión de reseñas de Google no está incluida en tu plan actual.
            Si quieres añadirla a tu cuenta, escríbenos y te contamos las opciones disponibles.
          </p>
          <Link
            href="/portal/resenas"
            className="mt-4 inline-flex items-center gap-2 text-sm text-kairikos-accent2 hover:underline"
            data-testid="resenas-summary-link"
          >
            Ver detalles →
          </Link>
        </section>
      ) : null}

      {availableProductCodes.length > 0 ? (
        <section className="card" aria-label="Productos disponibles" data-testid="available-products-section">
          <header className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Productos disponibles</h2>
            <Link href="/portal/productos" className="text-sm text-kairikos-accent2 hover:underline">
              Añadir producto →
            </Link>
          </header>
          <ul className="flex flex-wrap gap-2">
            {availableProductCodes.map((code) => (
              <li key={code}>
                <Link
                  href="/portal/productos"
                  className="pill-muted"
                  data-testid={`available-product-${code}`}
                >
                  {isProductCode(code) ? PRODUCT_CATALOGS[code].label : code}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
