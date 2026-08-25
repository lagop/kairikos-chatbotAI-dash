import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { SelfServeProductCard, type SelfServeTierOption } from '@/components/portal/SelfServeProductCard';
import { RequestWebQuoteCard } from '@/components/portal/RequestWebQuoteCard';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { requirePortalSession } from '@/lib/session';
import { resolveClientFromSession } from '@/lib/portal-session';
import { WEB_ACCESSIBLE_STATUSES } from '@/lib/client-product-access';
import { PRODUCT_CODES, PRODUCT_CATALOGS, type ProductCode } from '@/lib/catalogs';

// WP-XX — mirrors the status vocabulary/labels used by /portal/web's own
// project picker (see that page) — duplicated rather than shared, same
// small-per-component-map convention already used by ProductAssignment.tsx
// (admin) for the equivalent status pill.
const WEB_STATUS_LABEL: Record<string, string> = {
  quote_pending: 'Presupuesto en curso',
  active: 'Activo',
  paused: 'Pausado',
};
const WEB_STATUS_PILL: Record<string, string> = {
  quote_pending: 'pill-warning',
  active: 'pill-success',
  paused: 'pill-warning',
};

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Añadir producto · Portal Kairikos',
  description: 'Contrata un producto adicional sin pasar por un operador.',
  alternates: { canonical: '/portal/productos' },
  robots: { index: false, follow: false },
};

// Tier codes are English across the whole catalog (starter/pro/premium,
// basic, standard, solo/team/business) — this maps the ones whose
// capitalised form would read wrong in a Spanish UI. Anything unmapped
// falls back to Capitalised, which is right for starter/pro/premium.
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

export default async function PortalProductsPage({
  searchParams,
}: {
  searchParams: { checkout?: string };
}) {
  await requirePortalSession();
  const resolved = await resolveClientFromSession();
  if (!resolved) {
    redirect('/portal/login?next=/portal/productos');
  }

  if (!isDatabaseConfigured || resolved.source !== 'database') {
    return (
      <div className="space-y-6">
        <PageHeading eyebrow="Portal · productos" title="Añadir producto" />
        <EmptyState
          title="No disponible en modo demo"
          description="La contratación de productos requiere una cuenta real conectada a facturación."
        />
      </div>
    );
  }

  const clientProducts = await prisma.clientProduct.findMany({
    where: { clientId: resolved.clientId },
    select: {
      id: true,
      status: true,
      productId: true,
      subscribedAt: true,
      product: { select: { code: true } },
      webBrief: { select: { businessName: true } },
    },
  });
  const contractedCodes = new Set(
    clientProducts.filter((cp) => cp.status === 'active' || cp.status === 'paused').map((cp) => cp.product.code),
  );
  const pendingByCode = new Map(
    clientProducts.filter((cp) => cp.status === 'pending_payment').map((cp) => [cp.product.code, cp.productId]),
  );
  // WP-XX — 'web' no longer has a fixed self-serve price (custom quote,
  // see canAccessWebProduct / RequestWebQuoteCard) AND a client can have
  // multiple independent 'web' projects (see ClientProduct's schema
  // comment). It's excluded from the generic tiered grid below entirely;
  // instead every project in an accessible status gets its own status
  // pill + link to /portal/web/[id]. Requesting another project is only
  // blocked while one is 'quote_pending' — the entire pre-payment
  // negotiation window — same rule as /portal/web's own resolver.
  const webRows = clientProducts
    .filter((cp) => cp.product.code === 'web' && WEB_ACCESSIBLE_STATUSES.includes(cp.status))
    .sort((a, b) => a.subscribedAt.getTime() - b.subscribedAt.getTime());
  const canRequestWebQuote = !webRows.some((cp) => cp.status === 'quote_pending');

  const allProducts = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: [{ code: 'asc' }, { priceCents: 'asc' }],
    select: { id: true, code: true, tier: true, priceCents: true, setupFeeCents: true, currency: true },
  });
  const tiersByCode = new Map<string, SelfServeTierOption[]>();
  for (const p of allProducts) {
    const list = tiersByCode.get(p.code) ?? [];
    list.push({
      productId: p.id,
      tier: p.tier,
      tierLabel: tierLabel(p.tier),
      priceCents: p.priceCents,
      setupFeeCents: p.setupFeeCents,
      currency: p.currency,
    });
    tiersByCode.set(p.code, list);
  }

  const availableCodes = Array.from(tiersByCode.keys()).filter((code) => code !== 'web' && !contractedCodes.has(code));

  return (
    <div className="space-y-6">
      <div className="text-sm text-kairikos-muted">
        <Link href="/portal" className="hover:text-kairikos-text">← Volver al resumen</Link>
      </div>

      <PageHeading
        eyebrow="Portal · productos"
        title="Añadir producto"
        description="Contrata un producto adicional sin pasar por un operador. El pago se gestiona con Stripe."
      />

      {searchParams.checkout === 'cancelled' ? (
        <div className="card border-kairikos-warning/40 bg-kairikos-warning/10 p-4 text-sm" data-testid="checkout-cancelled-banner">
          Cancelaste el pago — no se ha cobrado nada. Puedes intentarlo de nuevo cuando quieras.
        </div>
      ) : null}

      {availableCodes.length === 0 && !canRequestWebQuote && webRows.length === 0 ? (
        <EmptyState
          title="Ya tienes todos los productos disponibles"
          description="No hay productos adicionales que contratar por ahora."
        />
      ) : (
        <>
          {webRows.length > 0 ? (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-kairikos-muted">Tus proyectos web</h2>
              <ul className="space-y-2" data-testid="productos-web-project-list">
                {webRows.map((row, index) => (
                  <li key={row.id}>
                    <Link
                      href={`/portal/web/${row.id}`}
                      className="card flex items-center justify-between gap-3 transition hover:border-kairikos-accent/40"
                      data-testid="productos-web-project-row"
                    >
                      <span className="font-medium">{row.webBrief?.businessName || `Proyecto ${index + 1}`}</span>
                      <span className={WEB_STATUS_PILL[row.status] ?? 'pill-muted'}>
                        {WEB_STATUS_LABEL[row.status] ?? row.status}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {canRequestWebQuote ? (
              <RequestWebQuoteCard label={webRows.length > 0 ? 'Solicitar otro proyecto web' : PRODUCT_CATALOGS.web.label} />
            ) : null}
            {availableCodes.map((code) => {
              const label = isProductCode(code) ? PRODUCT_CATALOGS[code].label : code;
              const pendingProductId = pendingByCode.get(code);
              const card = pendingProductId ? (
                <SelfServeProductCard key={code} code={code} label={label} status="pending" productId={pendingProductId} />
              ) : (
                <SelfServeProductCard key={code} code={code} label={label} status="available" tiers={tiersByCode.get(code) ?? []} />
              );
              // Reseñas publica un tercer plan, Enterprise, con precio a
              // medida — no tiene un Price de Stripe fijo que cobrar por
              // autoservicio (kairikos.com/resenas-google lo deja explícito),
              // así que no es una fila de Product; en vez de eso, esta nota
              // enlaza a soporte para ese caso.
              if (code !== 'reviews') return card;
              return (
                <div key={code} className="space-y-2">
                  {card}
                  <p className="px-1 text-xs text-kairikos-muted">
                    ¿Necesitas más volumen?{' '}
                    <Link href="/portal/support" className="underline hover:text-kairikos-text">
                      Habla con nosotros
                    </Link>{' '}
                    sobre el plan Enterprise.
                  </p>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
