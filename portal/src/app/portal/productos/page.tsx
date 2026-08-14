import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { PageHeading } from '@/components/portal/PageHeading';
import { EmptyState } from '@/components/portal/EmptyState';
import { SelfServeProductCard, type SelfServeTierOption } from '@/components/portal/SelfServeProductCard';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { resolveClientFromSession } from '@/lib/portal-session';
import { PRODUCT_CODES, PRODUCT_CATALOGS, type ProductCode } from '@/lib/catalogs';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Añadir producto · Portal Kairikos',
  description: 'Contrata un producto adicional sin pasar por un operador.',
  alternates: { canonical: '/portal/productos' },
  robots: { index: false, follow: false },
};

function tierLabel(tier: string): string {
  return tier === 'standard' ? 'Estándar' : tier.charAt(0).toUpperCase() + tier.slice(1);
}

function isProductCode(value: string): value is ProductCode {
  return (PRODUCT_CODES as readonly string[]).includes(value);
}

export default async function PortalProductsPage({
  searchParams,
}: {
  searchParams: { checkout?: string };
}) {
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
    select: { status: true, productId: true, product: { select: { code: true } } },
  });
  const contractedCodes = new Set(
    clientProducts.filter((cp) => cp.status === 'active' || cp.status === 'paused').map((cp) => cp.product.code),
  );
  const pendingByCode = new Map(
    clientProducts.filter((cp) => cp.status === 'pending_payment').map((cp) => [cp.product.code, cp.productId]),
  );

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

  const availableCodes = Array.from(tiersByCode.keys()).filter((code) => !contractedCodes.has(code));

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

      {availableCodes.length === 0 ? (
        <EmptyState
          title="Ya tienes todos los productos disponibles"
          description="No hay productos adicionales que contratar por ahora."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
      )}
    </div>
  );
}
