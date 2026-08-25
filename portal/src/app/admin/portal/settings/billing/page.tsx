import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import { PageHeading } from '@/components/portal/PageHeading';
import { getStripeCredentialStatus } from '@/lib/stripe-credentials';
import { StripeCatalogSettingsPanel } from '@/components/portal/StripeCatalogSettingsPanel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Stripe · Admin',
  description: 'Credenciales de Stripe y precios del catálogo de productos.',
  alternates: { canonical: '/admin/portal/settings/billing' },
  robots: { index: false, follow: false },
};

export default async function AdminBillingSettingsPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/settings/billing');
  }

  const [credentials, productRows] = await Promise.all([
    getStripeCredentialStatus(),
    prisma.product.findMany({
      // Inactive products are listed too. Bootstrapping a product on
      // Stripe has to be possible BEFORE it goes on sale — filtering
      // them out here forced the operator to expose a product to
      // clients in order to be allowed to give it prices, leaving a
      // window where the checkout returns 502.
      orderBy: [{ isActive: 'desc' }, { code: 'asc' }, { priceCents: 'asc' }],
      select: {
        id: true,
        code: true,
        tier: true,
        name: true,
        isActive: true,
        priceCents: true,
        setupFeeCents: true,
        currency: true,
        stripeProductId: true,
        stripeRecurringPriceId: true,
        stripeSetupPriceId: true,
        stripePriceMode: true,
      },
    }),
  ]);
  // stripePriceMode is a free-form column ('test' | 'live' | NULL by
  // convention, enforced by stripe-catalog.ts on write) — narrow it here
  // for the client component's stricter StripeMode type.
  function narrowMode(value: string | null): 'test' | 'live' | null {
    return value === 'test' || value === 'live' ? value : null;
  }
  const products = productRows.map((p) => ({ ...p, stripePriceMode: narrowMode(p.stripePriceMode) }));

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Operador"
        title="Stripe"
        description="Guarda tu clave de Stripe y crea o cambia los precios del catálogo directamente desde aquí, sin tocar el Dashboard de Stripe."
        actions={
          <Link href="/admin/portal/clients" className="btn-ghost">
            ← Volver a clientes
          </Link>
        }
      />
      <StripeCatalogSettingsPanel initialCredentials={credentials} initialProducts={products} />
    </div>
  );
}
