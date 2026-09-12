import { EmptyState } from '@/components/portal/EmptyState';
import { SelfServeSignupForm, type SignupTierOption } from '@/components/public/SelfServeSignupForm';
import { ThemeToggle } from '@/components/portal/ThemeToggle';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { PRODUCT_CODES, PRODUCT_CATALOGS, type ProductCode } from '@/lib/catalogs';

// =============================================================================
// /empezar (WP-31) — public, no session required. A visitor creates their
// own account and buys a product directly, without an operator creating
// the account first. Deliberately NOT under /portal — middleware.ts only
// gates /portal/:path* and /admin/portal/:path*, so this route (like
// /chatbot/intake and /api/public/*) needs no exemption added there.
//
// Only lists Product rows with selfServeEligible=true — that flag is the
// single source of truth for what shows up here (see the column's
// comment in schema.prisma); this page does no product-code filtering
// of its own.
// =============================================================================

// Same small display-label map as /portal/productos's tierLabel() —
// duplicated rather than shared, it's a 6-line formatting helper, not
// business logic that would cost anything if the two copies drift.
const TIER_DISPLAY: Record<string, string> = {
  standard: 'Estándar',
  solo: 'Autónomo',
  team: 'Equipo',
  business: 'Empresa',
};

function tierLabel(tier: string): string {
  return TIER_DISPLAY[tier] ?? tier.charAt(0).toUpperCase() + tier.slice(1);
}

function isProductCode(value: string): value is ProductCode {
  return (PRODUCT_CODES as readonly string[]).includes(value);
}

export const dynamic = 'force-dynamic';

export default async function EmpezarPage() {
  if (!isDatabaseConfigured) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <div className="mb-4 flex justify-end">
          <ThemeToggle />
        </div>
        <EmptyState title="No disponible en modo demo" description="El alta requiere una cuenta real conectada a base de datos." />
      </div>
    );
  }

  const products = await prisma.product.findMany({
    where: { isActive: true, selfServeEligible: true },
    orderBy: [{ code: 'asc' }, { priceCents: 'asc' }],
    select: { id: true, code: true, tier: true, priceCents: true, setupFeeCents: true, currency: true },
  });

  const tiers: SignupTierOption[] = products.map((p) => ({
    productId: p.id,
    code: p.code,
    label: isProductCode(p.code) ? PRODUCT_CATALOGS[p.code].label : p.code,
    tier: p.tier,
    tierLabel: tierLabel(p.tier),
    priceCents: p.priceCents,
    setupFeeCents: p.setupFeeCents,
    currency: p.currency,
    requiresQuote: false,
  }));

  // 'web' is deliberately outside the selfServeEligible query above —
  // it has no fixed catalog price (createProductCheckoutSession
  // rejects it unconditionally with product_requires_quote, same as
  // /portal/productos's own RequestWebQuoteCard special-case), so it
  // was invisible on this page entirely: a brand-new prospect with no
  // prior account had NO public way to ask for a website, only an
  // existing client could, from inside the portal. Same account
  // creation as every other tier here, but the final step is
  // POST /api/portal/web-quote/request (free, no Stripe) instead of a
  // Checkout Session — see SelfServeSignupForm's requiresQuote branch.
  const webProduct = await prisma.product.findFirst({
    where: { code: 'web', isActive: true },
    select: { id: true, tier: true, priceCents: true, setupFeeCents: true, currency: true },
  });
  if (webProduct) {
    tiers.push({
      productId: webProduct.id,
      code: 'web',
      label: isProductCode('web') ? PRODUCT_CATALOGS.web.label : 'web',
      tier: webProduct.tier,
      tierLabel: tierLabel(webProduct.tier),
      priceCents: webProduct.priceCents,
      setupFeeCents: webProduct.setupFeeCents,
      currency: webProduct.currency,
      requiresQuote: true,
    });
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <div className="mb-4 flex justify-end">
        <ThemeToggle />
      </div>
      <div className="mb-8 text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-kairikos-accent2">Kairikos</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Crea tu cuenta</h1>
        <p className="mt-3 text-sm text-kairikos-muted">
          Elige un producto, crea tu cuenta y paga — sin esperar a que nadie te dé de alta.
        </p>
      </div>

      {tiers.length === 0 ? (
        <EmptyState title="Sin productos disponibles" description="Ahora mismo no hay ningún producto en autoservicio. Escríbenos a hola@kairikos.com." />
      ) : (
        <SelfServeSignupForm tiers={tiers} />
      )}

      <p className="mt-8 text-center text-xs text-kairikos-muted">
        ¿Ya tienes cuenta?{' '}
        <a className="underline" href="/portal/login">
          Inicia sesión
        </a>
        .
      </p>
    </div>
  );
}
