import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { EmptyState } from '@/components/portal/EmptyState';
import { PageHeading } from '@/components/portal/PageHeading';
import { prisma, isDatabaseConfigured } from '@/lib/prisma';
import { getSession } from '@/lib/session';
import type { QuoterEstimate } from '@/lib/premium-quoter-engine';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Presupuestos Web Premium · Admin',
  description: 'Quién ha pedido un presupuesto de Web Premium.',
  alternates: { canonical: '/admin/portal/presupuestos-premium' },
  robots: { index: false, follow: false },
};

const STATUS_LABEL: Record<string, string> = {
  nuevo: 'Por llamar',
  contactado: 'Contactado',
  convertido: 'Ganado',
  descartado: 'Descartado',
};

const FECHA = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const EUROS = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0, useGrouping: true });

export default async function AdminPremiumQuotesPage() {
  const session = await getSession();
  if (!session.isOperator) {
    redirect('/portal/login?next=/admin/portal/presupuestos-premium');
  }

  const rows = isDatabaseConfigured
    ? await prisma.premiumQuoteRequest.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, company: true, contactName: true, email: true, phone: true, sector: true, status: true, estimate: true, createdAt: true },
      })
    : [];

  return (
    <div className="space-y-6">
      <PageHeading eyebrow="Operador" title="Presupuestos de Web Premium" description="Quién ha usado el presupuestador y ha pedido la propuesta detallada." />
      {rows.length === 0 ? (
        <EmptyState title="Todavía no ha pedido nadie un presupuesto" description="Cuando alguien envíe el formulario de /web-premium, aparecerá aquí con su contacto y su desglose." />
      ) : (
        <ul className="space-y-2" data-testid="premium-quotes-list">
          {rows.map((row) => {
            const estimate = row.estimate as unknown as QuoterEstimate;
            return (
              <li key={row.id} className="card">
                <Link href={`/admin/portal/presupuestos-premium/${row.id}`} className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-xs uppercase tracking-wider text-kairikos-muted">
                      {FECHA.format(row.createdAt)} · {row.sector}
                    </p>
                    <h2 className="mt-1 text-base font-semibold">{row.company}</h2>
                    <p className="text-sm text-kairikos-muted">
                      {row.contactName} · {row.email}
                      {row.phone ? ` · ${row.phone}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{EUROS.format(estimate.total)} €</span>
                    <span className={row.status === 'nuevo' ? 'pill-warning' : row.status === 'convertido' ? 'pill-success' : 'pill-muted'}>{STATUS_LABEL[row.status] ?? row.status}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
