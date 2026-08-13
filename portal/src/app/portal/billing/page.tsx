import type { Metadata } from 'next';
import { PageHeading } from '@/components/portal/PageHeading';
import { formatPriceEUR, getBilling } from '@/lib/portal-data';
import { assertSameClient, requirePortalSession } from '@/lib/session';
import { TIER_LABEL } from '@/lib/billing-tier';

export const metadata: Metadata = {
  title: 'Facturación',
  description: 'Tu plan actual, próxima factura y acceso al portal de pago de Stripe.',
  alternates: { canonical: '/portal/billing' },
  robots: { index: false, follow: false },
};

const DATE_FMT = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });

export default async function BillingPage({
  searchParams,
}: {
  searchParams: { client?: string };
}) {
  const session = await requirePortalSession();
  assertSameClient(session, searchParams.client ?? null);
  const billing = await getBilling(session.accessToken ?? '');

  return (
    <div className="space-y-6">
      <PageHeading
        eyebrow="Facturación"
        title="Tu plan y próximas facturas"
        description="Consulta el plan contratado, la cuota mensual y gestiona el método de pago desde Stripe."
        actions={
          billing.stripeCustomerPortalUrl ? (
            <a
              href={billing.stripeCustomerPortalUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="btn-primary"
              data-testid="stripe-portal-link"
            >
              Abrir portal de pago
            </a>
          ) : null
        }
      />

      <section
        className="grid grid-cols-1 gap-4 md:grid-cols-3"
        aria-label="Resumen de facturación"
      >
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Plan</p>
          <p
            className="mt-1 text-lg font-semibold"
            data-testid="tier-badge"
            data-tier={billing.tier}
          >
            {TIER_LABEL[billing.tier] ?? billing.tierLabel}
          </p>
          <p className="mt-1 text-xs text-kairikos-muted">Cuota mensual</p>
        </div>
        <div className="card">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Cuota</p>
          <p className="mt-1 text-lg font-semibold">{formatPriceEUR(billing.monthlyFeeCents)}</p>
          <p className="mt-1 text-xs text-kairikos-muted">IVA no incluido</p>
        </div>
        <div className="card" data-testid="invoice-info">
          <p className="text-xs uppercase tracking-wider text-kairikos-muted">Próxima factura</p>
          <p
            className="mt-1 text-lg font-semibold"
            data-testid="next-invoice-date"
          >
            {billing.nextInvoiceDate ? DATE_FMT.format(new Date(billing.nextInvoiceDate)) : '—'}
          </p>
          {billing.nextInvoiceAmountCents != null ? (
            <p className="mt-1 text-xs text-kairikos-muted">
              Importe estimado: {formatPriceEUR(billing.nextInvoiceAmountCents)}
            </p>
          ) : null}
        </div>
      </section>

      <section className="card text-sm text-kairikos-muted" aria-label="Información adicional">
        <p>
          El cambio de plan, método de pago o datos de facturación se gestiona desde el portal seguro de
          Stripe. Tras cualquier cambio, esta vista se actualizará automáticamente.
        </p>
        <p className="mt-3">
          ¿Necesitas ayuda con tu factura?{' '}
          <a className="text-kairikos-accent2 hover:underline" href="/portal/support">
            Escríbenos
          </a>
          .
        </p>
      </section>
    </div>
  );
}
